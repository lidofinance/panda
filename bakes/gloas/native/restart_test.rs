//! P1 component regression. Real EL/BN/VC restart is tested separately in restart.ts.
use beacon_chain::test_utils::{BeaconChainHarness, SyncCommitteeStrategy};
use fork_choice::ForkChoiceStore;
use operation_pool::PersistedOperationPool;
use state_processing::state_advance::complete_state_advance;
use std::collections::HashSet;
use store::StoreItem;
use types::{EthSpec, ForkName, MainnetEthSpec, PayloadAttestationData, Slot};

#[tokio::test]
async fn completed_tail_drains_fork_choice_and_keeps_included_pool_votes() {
    type E = MainnetEthSpec;
    let spec = ForkName::Altair.make_genesis_spec(E::default_spec());
    let harness = BeaconChainHarness::builder(MainnetEthSpec)
        .spec(spec.into())
        .deterministic_keypairs(64)
        .fresh_ephemeral_store()
        .build();
    let validators: Vec<_> = (0..64).collect();
    harness
        .add_attested_block_at_slot_with_sync(
            Slot::new(1),
            harness.get_current_state(),
            &validators,
            SyncCommitteeStrategy::AllValidators,
        )
        .await
        .unwrap();
    let chain = &harness.chain;
    assert!(
        !chain
            .canonical_head
            .fork_choice_read_lock()
            .queued_attestations()
            .is_empty(),
        "fixture needs current-slot votes before the tail"
    );
    // This is the actual operation performed by state_advance_timer at the completed slot tail.
    chain.recompute_head_at_slot(Slot::new(2)).await;
    {
        let fc = chain.canonical_head.fork_choice_read_lock();
        assert!(
            fc.queued_attestations().is_empty(),
            "completed tail left unprocessed votes"
        );
        assert_eq!(
            fc.fc_store().get_current_slot(),
            Slot::new(2),
            "FC time is ahead of the protocol slot"
        );
    }
    let head = chain.head_snapshot();
    let mut next_state = head.beacon_state.clone();
    complete_state_advance(
        &mut next_state,
        Some(head.beacon_state_root()),
        Slot::new(2),
        None,
        &chain.spec,
    )
    .unwrap();
    let before_sync = chain
        .op_pool
        .get_sync_aggregate(&next_state)
        .unwrap()
        .unwrap();
    assert_eq!(before_sync.sync_committee_bits.num_set_bits(), 512);
    let bytes = PersistedOperationPool::from_operation_pool(&chain.op_pool).as_store_bytes();
    let restored = PersistedOperationPool::<E>::from_store_bytes(&bytes)
        .unwrap()
        .into_operation_pool()
        .unwrap();
    assert_eq!(
        restored.get_sync_aggregate(&next_state).unwrap().unwrap(),
        before_sync
    );
    let naive: Vec<_> = chain
        .naive_aggregation_pool
        .read()
        .iter()
        .cloned()
        .collect();
    assert!(
        !naive.is_empty(),
        "fixture must contain actual naive attestations"
    );
    let persisted: Vec<_> = restored
        .attestations
        .read()
        .iter()
        .map(|att| att.clone_as_attestation())
        .collect();
    for attestation in naive {
        assert!(
            persisted.contains(&attestation),
            "naive attestation required by the next block is missing from persisted pool"
        );
    }
}

#[tokio::test]
async fn persisted_pool_preserves_verified_ptc_for_the_next_block() {
    type E = MainnetEthSpec;
    // A genesis component fixture needs no execution service, mocked or otherwise.
    let spec = ForkName::Gloas.make_genesis_spec(E::default_spec());
    let harness = BeaconChainHarness::builder(MainnetEthSpec)
        .spec(spec.into())
        .deterministic_keypairs(64)
        .fresh_ephemeral_store()
        .build();
    let chain = &harness.chain;
    let head = chain.head_snapshot();
    let slot = head.beacon_state.slot();
    chain.slot_clock.set_slot(slot.as_u64());
    let ptc = head.beacon_state.get_ptc(slot, &chain.spec).unwrap();
    let validators: HashSet<_> = ptc.0.iter().copied().collect();
    assert!(
        validators.len() < ptc.0.len(),
        "fixture must exercise repeated committee indices"
    );
    let data = PayloadAttestationData {
        beacon_block_root: head.beacon_block_root,
        slot,
        payload_present: true,
        blob_data_available: true,
    };
    for index in validators.iter().copied() {
        let message = harness.make_payload_attestation_message(
            index,
            data.clone(),
            &head.beacon_state.fork(),
        );
        // Ordinary gossip verification checks BLS, membership, slot and the known block root.
        let verified = chain
            .verify_payload_attestation_message_for_gossip(message)
            .unwrap();
        chain
            .apply_payload_attestation_to_fork_choice(
                verified.indexed_payload_attestation(),
                verified.ptc(),
            )
            .unwrap();
        chain.add_payload_attestation_to_pool(&verified).unwrap();
    }
    assert_eq!(
        chain.op_pool.num_payload_attestation_messages(),
        validators.len()
    );
    let mut next_state = head.beacon_state.clone();
    complete_state_advance(
        &mut next_state,
        Some(head.beacon_state_root()),
        slot + Slot::new(1),
        None,
        &chain.spec,
    )
    .unwrap();
    let before = chain
        .op_pool
        .get_payload_attestations(&next_state, head.beacon_block_root, &chain.spec)
        .unwrap();
    assert_eq!(before.len(), 1);
    assert_eq!(before[0].aggregation_bits.num_set_bits(), 512);
    assert_eq!(before[0].data, data);
    let keys: Vec<_> = ptc
        .0
        .iter()
        .map(|index| &harness.validator_keypairs[*index].pk)
        .collect();
    use types::{Domain, SignedRoot};
    let domain = chain.spec.get_domain(
        slot.epoch(E::slots_per_epoch()),
        Domain::PTCAttester,
        &head.beacon_state.fork(),
        head.beacon_state.genesis_validators_root(),
    );
    assert!(
        before[0]
            .signature
            .fast_aggregate_verify(data.signing_root(domain), &keys)
    );
    // Exercise the same serialization and decode entrypoints as the production store.
    let bytes = PersistedOperationPool::from_operation_pool(&chain.op_pool).as_store_bytes();
    let restored = PersistedOperationPool::<E>::from_store_bytes(&bytes)
        .unwrap()
        .into_operation_pool()
        .unwrap();
    let after = restored
        .get_payload_attestations(&next_state, head.beacon_block_root, &chain.spec)
        .unwrap();
    assert_eq!(
        after, before,
        "persisted operation pool lost verified next-slot PTC votes"
    );
}
