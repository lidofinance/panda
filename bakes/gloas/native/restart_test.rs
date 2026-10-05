//! P1 component regression. Real EL/BN/VC restart is tested separately in restart.ts.
use beacon_chain::test_utils::{AttestationStrategy, BeaconChainHarness, SyncCommitteeStrategy};
use fork_choice::ForkChoiceStore;
use operation_pool::PersistedOperationPool;
use state_processing::state_advance::complete_state_advance;
use std::collections::HashSet;
use store::StoreItem;
use types::{EthSpec, ForkName, MainnetEthSpec, PayloadAttestationData, Slot};

#[tokio::test]
async fn persist_transfers_verified_naive_votes_without_an_aggregator_or_an_extra_block() {
    type E = MainnetEthSpec;
    // A real CL component fixture needs no execution service. Slot 32 crosses an epoch.
    let spec = ForkName::Altair.make_genesis_spec(E::default_spec());
    let harness = BeaconChainHarness::builder(MainnetEthSpec)
        .spec(spec.into())
        .deterministic_keypairs(64)
        .fresh_ephemeral_store()
        .build();
    harness
        .add_attested_block_at_slot(Slot::new(32), harness.get_current_state(), &[])
        .await
        .unwrap();
    let chain = &harness.chain;
    let head = chain.head_snapshot();
    let unaggregated = harness.get_unaggregated_attestations(
        &AttestationStrategy::AllValidators,
        &head.beacon_state,
        head.beacon_state_root(),
        head.beacon_block_root,
        Slot::new(32),
    );
    // Use ordinary gossip verification, but deliver no SignedAggregateAndProof.
    harness.process_attestations(
        unaggregated
            .into_iter()
            .map(|messages| (messages, None))
            .collect(),
        &head.beacon_state,
    );
    assert_eq!(
        chain.op_pool.num_attestations(),
        0,
        "fixture already persisted the votes"
    );
    let naive: Vec<_> = chain
        .naive_aggregation_pool
        .read()
        .iter()
        .cloned()
        .collect();
    assert!(!naive.is_empty());
    chain.persist_op_pool().unwrap();
    let restored = chain
        .store
        .get_item::<PersistedOperationPool<E>>(&types::Hash256::ZERO)
        .unwrap()
        .unwrap()
        .into_operation_pool()
        .unwrap();
    let persisted: Vec<_> = restored
        .attestations
        .read()
        .iter()
        .map(|att| att.clone_as_attestation())
        .collect();
    for attestation in &naive {
        assert!(
            persisted.contains(attestation),
            "verified naive vote lost at checkpoint"
        );
    }
    assert_eq!(
        chain.head_snapshot().beacon_block_root,
        head.beacon_block_root
    );
    assert_eq!(chain.head_snapshot().beacon_state.slot(), Slot::new(32));
}

#[test]
fn panda_pool_rejects_corrupt_and_unknown_formats_but_reads_legacy() {
    use operation_pool::{OperationPool, PersistedOperationPoolV20};
    type E = MainnetEthSpec;
    let legacy = PersistedOperationPoolV20::<E> {
        attestations: vec![],
        sync_contributions: vec![],
        attester_slashings: vec![],
        proposer_slashings: vec![],
        voluntary_exits: vec![],
        bls_to_execution_changes: vec![],
        capella_bls_change_broadcast_indices: vec![],
    };
    let decoded = PersistedOperationPool::<E>::from_store_bytes(&legacy.as_store_bytes()).unwrap();
    assert!(matches!(decoded, PersistedOperationPool::V20(_)));
    let bytes =
        PersistedOperationPool::from_operation_pool(&OperationPool::<E>::new()).as_store_bytes();
    assert!(bytes.starts_with(b"PANDAOPPOOL\0"));
    for length in 0..bytes.len() {
        assert!(PersistedOperationPool::<E>::from_store_bytes(&bytes[..length]).is_err());
    }
    for offset in 0..bytes.len() {
        let mut corrupt = bytes.clone();
        corrupt[offset] ^= 0x80;
        assert!(
            PersistedOperationPool::<E>::from_store_bytes(&corrupt).is_err(),
            "offset {offset}"
        );
    }
}

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
    // Real store entrypoints must persist the same verified messages, and a failed write must
    // propagate rather than report a successful save or erase the previous record.
    use store::KeyValueStore;
    use types::Hash256;
    chain.persist_op_pool().unwrap();
    let stored = chain
        .store
        .get_item::<PersistedOperationPool<E>>(&Hash256::ZERO)
        .unwrap()
        .unwrap()
        .into_operation_pool()
        .unwrap();
    assert_eq!(
        stored
            .get_payload_attestations(&next_state, head.beacon_block_root, &chain.spec)
            .unwrap(),
        before
    );
    let previous = chain
        .store
        .hot_db
        .get_bytes(store::DBColumn::OpPool, Hash256::ZERO.as_slice())
        .unwrap();
    chain.store.hot_db.inject_faults(true);
    let failed = chain.persist_op_pool();
    chain.store.hot_db.inject_faults(false);
    assert!(failed.is_err(), "failed database write must be visible");
    assert_eq!(
        chain
            .store
            .hot_db
            .get_bytes(store::DBColumn::OpPool, Hash256::ZERO.as_slice())
            .unwrap(),
        previous
    );
}

#[tokio::test]
async fn cold_resume_refuses_a_missing_operation_pool_instead_of_starting_empty() {
    use store::KeyValueStore;
    use types::Hash256;
    let spec = ForkName::Altair.make_genesis_spec(MainnetEthSpec::default_spec());
    let harness = BeaconChainHarness::builder(MainnetEthSpec)
        .spec(spec.clone().into())
        .deterministic_keypairs(64)
        .fresh_ephemeral_store()
        .build();
    harness.chain.persist_op_pool().unwrap();
    harness.chain.persist_fork_choice().unwrap();
    harness
        .chain
        .store
        .hot_db
        .key_delete(store::DBColumn::OpPool, Hash256::ZERO.as_slice())
        .unwrap();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        BeaconChainHarness::builder(MainnetEthSpec)
            .spec(spec.into())
            .deterministic_keypairs(64)
            .resumed_ephemeral_store(harness.chain.store.clone())
            .build()
    }));
    assert!(
        result.is_err(),
        "cold resume silently replaced the missing operation pool with an empty pool"
    );
}

#[tokio::test]
async fn native_checkpoint_ack_is_durable_and_refuses_missing_or_changed_records() {
    use beacon_chain::panda_checkpoint::PandaCheckpoint;
    use beacon_chain::test_utils::EphemeralHarnessType;
    use slot_clock::SlotClock;
    use store::KeyValueStore;
    use types::Hash256;
    type E = MainnetEthSpec;
    let spec = ForkName::Altair.make_genesis_spec(E::default_spec());
    let harness = BeaconChainHarness::builder(MainnetEthSpec)
        .spec(spec.into())
        .deterministic_keypairs(64)
        .fresh_ephemeral_store()
        .build();
    let chain = &harness.chain;
    let now = chain.slot_clock.now_duration().unwrap().as_millis() as u64;
    assert!(PandaCheckpoint::validate_store::<EphemeralHarnessType<E>>(&chain.store, now).is_err());
    let ack = chain.panda_checkpoint_at(now).unwrap();
    assert_eq!(
        chain.panda_checkpoint_status().unwrap().checkpoint_hash,
        ack.checkpoint_hash
    );
    assert_eq!(ack.checkpoint.now_ms, now);
    assert_eq!(
        ack.checkpoint.head_block_root,
        chain.head_snapshot().beacon_block_root
    );
    assert_eq!(
        ack.checkpoint.fork_choice_slot,
        chain
            .canonical_head
            .fork_choice_read_lock()
            .fc_store()
            .get_current_slot()
            .as_u64()
    );
    assert_eq!(
        PandaCheckpoint::validate_store::<EphemeralHarnessType<E>>(&chain.store, now).unwrap(),
        ack.checkpoint
    );
    assert!(
        PandaCheckpoint::validate_store::<EphemeralHarnessType<E>>(&chain.store, now + 1).is_err()
    );
    let key = Hash256::repeat_byte(0x50);
    let prior = chain
        .store
        .hot_db
        .get_bytes(store::DBColumn::BeaconChain, key.as_slice())
        .unwrap();
    chain.store.hot_db.inject_faults(true);
    assert!(
        chain.panda_checkpoint_at(now).is_err(),
        "write failure received a success ACK"
    );
    chain.store.hot_db.inject_faults(false);
    assert_eq!(
        chain
            .store
            .hot_db
            .get_bytes(store::DBColumn::BeaconChain, key.as_slice())
            .unwrap(),
        prior
    );
    for column in [
        store::DBColumn::OpPool,
        store::DBColumn::ForkChoice,
        store::DBColumn::CustodyContext,
    ] {
        let bytes = chain
            .store
            .hot_db
            .get_bytes(column, Hash256::ZERO.as_slice())
            .unwrap()
            .unwrap();
        chain
            .store
            .hot_db
            .key_delete(column, Hash256::ZERO.as_slice())
            .unwrap();
        assert!(
            PandaCheckpoint::validate_store::<EphemeralHarnessType<E>>(&chain.store, now).is_err(),
            "missing {column:?} accepted"
        );
        let mut corrupt = bytes.clone();
        corrupt[0] ^= 0x80;
        chain
            .store
            .hot_db
            .put_bytes(column, Hash256::ZERO.as_slice(), &corrupt)
            .unwrap();
        assert!(
            PandaCheckpoint::validate_store::<EphemeralHarnessType<E>>(&chain.store, now).is_err(),
            "changed {column:?} accepted"
        );
        chain
            .store
            .hot_db
            .put_bytes(column, Hash256::ZERO.as_slice(), &bytes)
            .unwrap();
    }
    let receipt_bytes = prior.clone().unwrap();
    chain
        .store
        .cold_db
        .key_delete(store::DBColumn::BeaconChain, key.as_slice())
        .unwrap();
    assert!(
        PandaCheckpoint::validate_store::<EphemeralHarnessType<E>>(&chain.store, now).is_err(),
        "missing cold DB accepted"
    );
    chain
        .store
        .cold_db
        .put_bytes(store::DBColumn::BeaconChain, key.as_slice(), &receipt_bytes)
        .unwrap();
    chain
        .store
        .blobs_db
        .key_delete(store::DBColumn::BeaconChain, key.as_slice())
        .unwrap();
    assert!(
        PandaCheckpoint::validate_store::<EphemeralHarnessType<E>>(&chain.store, now).is_err(),
        "missing blob DB accepted"
    );
    chain
        .store
        .blobs_db
        .put_bytes(store::DBColumn::BeaconChain, key.as_slice(), &receipt_bytes)
        .unwrap();
    let mut corrupt = prior.unwrap();
    corrupt[0] ^= 0x80;
    chain
        .store
        .hot_db
        .put_bytes(store::DBColumn::BeaconChain, key.as_slice(), &corrupt)
        .unwrap();
    assert!(PandaCheckpoint::validate_store::<EphemeralHarnessType<E>>(&chain.store, now).is_err());
}

#[tokio::test]
async fn native_checkpoint_refuses_unfinished_cut_and_unpublished_payload() {
    use beacon_chain::pending_payload_envelopes::PendingEnvelopeData;
    use std::{sync::Arc, time::Duration};
    use types::{ExecutionPayloadEnvelope, ExecutionPayloadGloas, ExecutionRequestsGloas, Hash256};
    let spec = ForkName::Altair.make_genesis_spec(MainnetEthSpec::default_spec());
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
    let genesis = *chain.slot_clock.genesis_duration();
    chain
        .slot_clock
        .set_current_time(genesis + Duration::from_millis(12_000));
    assert!(
        chain
            .panda_checkpoint_at((genesis.as_millis() + 12_000) as u64)
            .is_err()
    );
    chain
        .slot_clock
        .set_current_time(genesis + Duration::from_millis(23_500));
    let now = (genesis.as_millis() + 23_500) as u64;
    assert!(
        chain.panda_checkpoint_at(now).is_err(),
        "unfinished fork choice accepted"
    );
    chain.recompute_head_at_slot(Slot::new(2)).await;
    chain.panda_checkpoint_at(now).unwrap();
    // The new block has genuine proposer signatures but has not been verified/imported.
    let ((future, _), _) = harness
        .make_block(harness.get_current_state(), Slot::new(2))
        .await;
    let future_root = future.canonical_root();
    chain
        .data_availability_checker
        .put_pre_execution_block(future_root, future, types::BlockImportSource::RangeSync)
        .unwrap();
    chain
        .slot_clock
        .set_current_time(genesis + Duration::from_millis(23_500));
    assert!(
        chain.panda_checkpoint_at(now).is_err(),
        "unimported block accepted"
    );
    chain
        .data_availability_checker
        .remove_block_on_execution_error(&future_root);
    chain.panda_checkpoint_at(now).unwrap();
    chain
        .pending_payload_envelopes
        .write()
        .insert(PendingEnvelopeData {
            envelope: Arc::new(ExecutionPayloadEnvelope {
                payload: ExecutionPayloadGloas::default(),
                execution_requests: ExecutionRequestsGloas::default(),
                builder_index: 0,
                beacon_block_root: Hash256::repeat_byte(77),
                parent_beacon_block_root: Hash256::ZERO,
            }),
            blobs: None,
        });
    assert!(
        chain
            .panda_checkpoint_at(now)
            .unwrap_err()
            .contains("unpublished")
    );
}

#[tokio::test]
async fn initial_genesis_tail_preserves_actual_zero_fork_choice_slot() {
    use beacon_chain::panda_checkpoint::PandaCheckpoint;
    use beacon_chain::test_utils::EphemeralHarnessType;
    use slot_clock::SlotClock;
    use std::time::Duration;
    let spec = ForkName::Gloas.make_genesis_spec(MainnetEthSpec::default_spec());
    let harness = BeaconChainHarness::builder(MainnetEthSpec)
        .spec(spec.into())
        .deterministic_keypairs(64)
        .fresh_ephemeral_store()
        .build();
    let chain = &harness.chain;
    let genesis = *chain.slot_clock.genesis_duration();
    let head = chain.head_snapshot().beacon_block_root;
    // Production startup begins at this offset. Its state-advance timer skips the already
    // elapsed 9s preparation phase, so no slot-zero lookahead ran and actual FC slot stays zero.
    chain
        .slot_clock
        .set_current_time(genesis + Duration::from_millis(11_500));
    let now = (genesis.as_millis() + 11_500) as u64;
    let ack = chain.panda_checkpoint_at(now).unwrap();
    assert_eq!(ack.checkpoint.now_ms, now);
    assert_eq!(ack.checkpoint.head_slot, 0);
    assert_eq!(ack.checkpoint.fork_choice_slot, 0);
    assert_eq!(ack.checkpoint.head_block_root, head);
    assert_eq!(
        PandaCheckpoint::validate_store::<EphemeralHarnessType<MainnetEthSpec>>(&chain.store, now)
            .unwrap(),
        ack.checkpoint
    );
    assert_eq!(
        chain.slot_clock.now_duration().unwrap().as_millis(),
        now as u128
    );
    // This special initial cut does not allow arbitrary timestamps or a later unfinished slot.
    for elapsed in [1, 9_000, 12_000, 23_500] {
        chain
            .slot_clock
            .set_current_time(genesis + Duration::from_millis(elapsed));
        assert!(
            chain
                .panda_checkpoint_at((genesis.as_millis() + elapsed as u128) as u64)
                .is_err()
        );
    }
}

fn gloas_genesis_tail() -> (
    BeaconChainHarness<beacon_chain::test_utils::EphemeralHarnessType<MainnetEthSpec>>,
    u64,
) {
    let spec = ForkName::Gloas.make_genesis_spec(MainnetEthSpec::default_spec());
    let harness = BeaconChainHarness::builder(MainnetEthSpec)
        .spec(spec.into())
        .deterministic_keypairs(64)
        .fresh_ephemeral_store()
        .build();
    let now =
        *harness.chain.slot_clock.genesis_duration() + std::time::Duration::from_millis(11_500);
    harness.chain.slot_clock.set_current_time(now);
    (harness, now.as_millis() as u64)
}

#[tokio::test]
async fn native_checkpoint_rejects_unpersisted_pending_payload_cache() {
    use beacon_chain::panda_checkpoint::PandaCheckpoint;
    use std::sync::Arc;
    use types::Hash256;

    let (harness, now) = gloas_genesis_tail();
    let chain = &harness.chain;
    let prior = chain.panda_checkpoint_at(now).unwrap().checkpoint;
    let head = chain.head_snapshot();
    // A stored block is not proof that its pending payload has been executed and persisted.
    // Put the genesis block's real bid into the actual pending cache, without an envelope.
    let bid = head
        .beacon_block
        .message()
        .body()
        .signed_execution_payload_bid()
        .unwrap()
        .clone();
    assert!(chain.pending_payload_cache.checkpoint_roots().is_empty());
    assert!(
        chain
            .store
            .get_payload_envelope(&head.beacon_block_root)
            .unwrap()
            .is_none()
    );
    chain
        .pending_payload_cache
        .insert_bid(head.beacon_block_root, Arc::new(bid));
    assert_eq!(
        chain.pending_payload_cache.checkpoint_roots(),
        vec![head.beacon_block_root]
    );
    assert_eq!(
        chain.panda_checkpoint_at(now).unwrap_err(),
        "Panda checkpoint payload envelope has not been persisted"
    );
    assert_eq!(
        chain
            .store
            .get_item::<PandaCheckpoint>(&Hash256::repeat_byte(0x50))
            .unwrap()
            .unwrap(),
        prior,
        "refused checkpoint replaced the previous acknowledged receipt"
    );
}

#[tokio::test]
async fn native_checkpoint_rejects_unpersisted_verified_naive_sync_votes() {
    use beacon_chain::panda_checkpoint::PandaCheckpoint;
    use beacon_chain::test_utils::RelativeSyncCommittee;
    use types::Hash256;

    let (harness, now) = gloas_genesis_tail();
    let chain = &harness.chain;
    let head = chain.head_snapshot();
    let contributions = harness.make_sync_contributions(
        &head.beacon_state,
        head.beacon_block_root,
        Slot::new(0),
        RelativeSyncCommittee::Current,
    );
    let message = contributions[0].0[0].0.clone();
    // This vote passes normal BLS/membership checks before entering the real naive pool.
    let verified = chain
        .verify_sync_committee_message_for_gossip(message, 0u64.into())
        .unwrap();
    chain.add_to_naive_sync_aggregation_pool(verified).unwrap();
    let naive_count = chain.naive_sync_aggregation_pool.read().iter().count();
    assert!(naive_count > 0);
    harness.process_sync_contributions(contributions).unwrap();
    let pool = PersistedOperationPool::from_operation_pool(&chain.op_pool);
    let saved: Vec<_> = pool
        .sync_contributions()
        .iter()
        .flat_map(|(_, values)| values.iter().cloned())
        .collect();
    assert!(!saved.is_empty());
    let prior = chain.panda_checkpoint_at(now).unwrap().checkpoint;

    // Remove the durable candidate contributions only; keep the required verified votes.
    chain.op_pool.prune_sync_contributions(Slot::new(2));
    assert_eq!(chain.op_pool.num_sync_contributions(), 0);
    assert_eq!(
        chain.naive_sync_aggregation_pool.read().iter().count(),
        naive_count
    );
    assert_eq!(
        chain.panda_checkpoint_at(now).unwrap_err(),
        "Panda checkpoint has unpersisted naive sync votes"
    );
    assert_eq!(
        chain
            .store
            .get_item::<PandaCheckpoint>(&Hash256::repeat_byte(0x50))
            .unwrap()
            .unwrap(),
        prior,
        "refused checkpoint replaced the previous acknowledged receipt"
    );

    // Restoring those same verified contributions makes the unchanged cut safe again.
    for contribution in saved {
        chain
            .op_pool
            .insert_sync_contribution(contribution)
            .unwrap();
    }
    let restored = chain.panda_checkpoint_at(now).unwrap().checkpoint;
    assert_eq!(restored.now_ms, prior.now_ms);
    assert_eq!(restored.head_block_root, prior.head_block_root);
    assert_eq!(restored.op_pool_hash, prior.op_pool_hash);
}

#[tokio::test]
async fn verified_user_operations_survive_restart_and_are_selected_only_once() {
    use operation_pool::{OperationPool, ReceivedPreCapella};
    use state_processing::per_block_processing::process_operations::{
        process_attester_slashings, process_bls_to_execution_changes, process_exits,
        process_proposer_slashings,
    };
    use state_processing::{AllCaches, ConsensusContext, VerifyOperation, VerifySignatures};
    use types::{Address, Hash256};
    type E = MainnetEthSpec;
    let spec = ForkName::Gloas.make_genesis_spec(E::default_spec());
    let harness = BeaconChainHarness::builder(MainnetEthSpec)
        .spec(spec.into())
        .deterministic_keypairs(64)
        .deterministic_withdrawal_keypairs(64)
        .fresh_ephemeral_store()
        .build();
    let mut state = harness.get_current_state();
    // Real transitions make validators old enough for a voluntary exit; mainnet delays remain.
    let exit_slot = Slot::new(harness.chain.spec.shard_committee_period * E::slots_per_epoch());
    complete_state_advance(&mut state, None, exit_slot, None, &harness.chain.spec).unwrap();
    state.build_all_caches(&harness.chain.spec).unwrap();
    let bls_index = state
        .validators()
        .iter()
        .enumerate()
        .find(|(index, validator)| {
            *index > 3 && !validator.has_execution_withdrawal_credential(&harness.chain.spec)
        })
        .unwrap()
        .0 as u64;
    let pool = OperationPool::<E>::new();
    pool.insert_proposer_slashing(
        harness
            .make_proposer_slashing(0)
            .validate(&state, &harness.chain.spec)
            .unwrap(),
    );
    pool.insert_attester_slashing(
        harness
            .make_attester_slashing(vec![1])
            .validate(&state, &harness.chain.spec)
            .unwrap(),
    );
    pool.insert_voluntary_exit(
        harness
            .make_voluntary_exit(2, state.current_epoch())
            .validate(&state, &harness.chain.spec)
            .unwrap(),
    );
    pool.insert_bls_to_execution_change(
        harness
            .make_bls_to_execution_change(bls_index, Address::repeat_byte(42))
            .validate(&state, &harness.chain.spec)
            .unwrap(),
        ReceivedPreCapella::No,
    );
    let expected = pool.get_slashings_and_exits(&state, &harness.chain.spec);
    let expected_changes = pool.get_bls_to_execution_changes(&state, &harness.chain.spec);
    assert_eq!(
        (
            expected.0.len(),
            expected.1.len(),
            expected.2.len(),
            expected_changes.len()
        ),
        (1, 1, 1, 1)
    );
    let bytes = PersistedOperationPool::from_operation_pool(&pool).as_store_bytes();
    let restored = PersistedOperationPool::<E>::from_store_bytes(&bytes)
        .unwrap()
        .into_operation_pool()
        .unwrap();
    assert_eq!(
        restored.get_slashings_and_exits(&state, &harness.chain.spec),
        expected
    );
    assert_eq!(
        restored.get_bls_to_execution_changes(&state, &harness.chain.spec),
        expected_changes
    );
    let mut context = ConsensusContext::new(state.slot());
    process_proposer_slashings(
        &mut state,
        &expected.0,
        VerifySignatures::True,
        &mut context,
        &harness.chain.spec,
    )
    .unwrap();
    process_attester_slashings(
        &mut state,
        expected.1.iter().map(|op| op.to_ref()),
        VerifySignatures::True,
        &mut context,
        &harness.chain.spec,
    )
    .unwrap();
    process_exits(
        &mut state,
        &expected.2,
        VerifySignatures::True,
        &harness.chain.spec,
    )
    .unwrap();
    process_bls_to_execution_changes(
        &mut state,
        &expected_changes,
        VerifySignatures::True,
        &harness.chain.spec,
    )
    .unwrap();
    assert!(state.get_validator(0).unwrap().slashed && state.get_validator(1).unwrap().slashed);
    assert_ne!(
        state.get_validator(2).unwrap().exit_epoch,
        harness.chain.spec.far_future_epoch
    );
    assert!(
        state
            .get_validator(bls_index as usize)
            .unwrap()
            .has_execution_withdrawal_credential(&harness.chain.spec)
    );
    // Already included operations remain retained until pruning, but cannot be selected again.
    assert_eq!(
        (
            restored.num_proposer_slashings(),
            restored.num_attester_slashings(),
            restored.num_voluntary_exits()
        ),
        (1, 1, 1)
    );
    let bytes = PersistedOperationPool::from_operation_pool(&restored).as_store_bytes();
    harness
        .chain
        .store
        .put_item(
            &Hash256::ZERO,
            &PersistedOperationPool::<E>::from_store_bytes(&bytes).unwrap(),
        )
        .unwrap();
    let included = harness
        .chain
        .store
        .get_item::<PersistedOperationPool<E>>(&Hash256::ZERO)
        .unwrap()
        .unwrap()
        .into_operation_pool()
        .unwrap();
    assert_eq!(
        included.get_slashings_and_exits(&state, &harness.chain.spec),
        (vec![], vec![], vec![])
    );
    assert!(
        included
            .get_bls_to_execution_changes(&state, &harness.chain.spec)
            .is_empty()
    );
}

#[tokio::test]
async fn checkpoint_preserves_next_sync_aggregate_after_expired_votes_are_pruned() {
    use beacon_chain::panda_checkpoint::PandaCheckpoint;
    use beacon_chain::test_utils::RelativeSyncCommittee;
    use std::collections::BTreeSet;
    use types::Hash256;
    type E = MainnetEthSpec;
    let spec = ForkName::Altair.make_genesis_spec(E::default_spec());
    let harness = BeaconChainHarness::builder(MainnetEthSpec)
        .spec(spec.into())
        .deterministic_keypairs(64)
        .fresh_ephemeral_store()
        .build();
    for slot in 1..=3 {
        harness
            .add_attested_block_at_slot(Slot::new(slot), harness.get_current_state(), &[])
            .await
            .unwrap();
        let head = harness.chain.head_snapshot();
        assert_eq!(head.beacon_block.slot(), Slot::new(slot));
        let contributions = harness.make_sync_contributions(
            &head.beacon_state,
            head.beacon_block_root,
            Slot::new(slot),
            RelativeSyncCommittee::Current,
        );
        let message = contributions[0].0[0].0.clone();
        let verified = harness
            .chain
            .verify_sync_committee_message_for_gossip(message, 0u64.into())
            .unwrap();
        harness
            .chain
            .add_to_naive_sync_aggregation_pool(verified)
            .unwrap();
        harness.process_sync_contributions(contributions).unwrap();
    }
    let chain = &harness.chain;
    let naive_slots: BTreeSet<_> = chain
        .naive_sync_aggregation_pool
        .read()
        .iter()
        .map(|vote| vote.slot.as_u64())
        .collect();
    assert_eq!(naive_slots, BTreeSet::from([1, 2, 3]));

    // The exact pruning operation performed by canonical_head after finalization.
    chain.op_pool.prune_sync_contributions(Slot::new(3));
    let pool = PersistedOperationPool::from_operation_pool(&chain.op_pool);
    let candidate_slots: BTreeSet<_> = pool
        .sync_contributions()
        .iter()
        .flat_map(|(_, values)| values)
        .map(|vote| vote.slot.as_u64())
        .collect();
    assert_eq!(candidate_slots, BTreeSet::from([2, 3]));
    let head = chain.head_snapshot();
    let mut next_state = head.beacon_state.clone();
    complete_state_advance(
        &mut next_state,
        Some(head.beacon_state_root()),
        Slot::new(4),
        None,
        &chain.spec,
    )
    .unwrap();
    let expected = chain
        .op_pool
        .get_sync_aggregate(&next_state)
        .unwrap()
        .unwrap();
    assert_eq!(expected.sync_committee_bits.num_set_bits(), 512);
    chain.recompute_head_at_slot(Slot::new(4)).await;
    let now = *chain.slot_clock.genesis_duration()
        + std::time::Duration::from_millis(3 * 12_000 + 11_500);
    chain.slot_clock.set_current_time(now);

    // RED on r3: slot 1 remains in naive storage but cannot be selected for block 4.
    // It must not require a contribution that ordinary pruning correctly removed.
    let checkpoint = chain.panda_checkpoint_at(now.as_millis() as u64).unwrap();
    assert_eq!(checkpoint.checkpoint.now_ms, now.as_millis() as u64);
    assert_eq!(
        checkpoint.checkpoint.head_block_root,
        head.beacon_block_root
    );
    let restored = chain
        .store
        .get_item::<PersistedOperationPool<E>>(&Hash256::ZERO)
        .unwrap()
        .unwrap()
        .into_operation_pool()
        .unwrap();
    assert_eq!(
        restored.get_sync_aggregate(&next_state).unwrap().unwrap(),
        expected
    );
    assert_eq!(
        chain
            .store
            .get_item::<PandaCheckpoint>(&Hash256::repeat_byte(0x50))
            .unwrap()
            .unwrap(),
        checkpoint.checkpoint
    );
}

#[tokio::test]
async fn checkpoint_requires_verified_future_sync_votes_admitted_with_clock_tolerance() {
    use beacon_chain::panda_checkpoint::PandaCheckpoint;
    use beacon_chain::test_utils::RelativeSyncCommittee;
    use types::Hash256;

    let (harness, now) = gloas_genesis_tail();
    let chain = &harness.chain;
    let prior = chain.panda_checkpoint_at(now).unwrap().checkpoint;
    let head = chain.head_snapshot();
    let contributions = harness.make_sync_contributions(
        &head.beacon_state,
        head.beacon_block_root,
        Slot::new(1),
        RelativeSyncCommittee::Current,
    );
    // At 11.5s the normal 500ms gossip tolerance admits a next-slot message.
    // It must remain required even though it is not the current protocol slot.
    let verified = chain
        .verify_sync_committee_message_for_gossip(contributions[0].0[0].0.clone(), 0u64.into())
        .unwrap();
    chain.add_to_naive_sync_aggregation_pool(verified).unwrap();
    assert!(
        chain
            .naive_sync_aggregation_pool
            .read()
            .iter()
            .any(|vote| vote.slot == Slot::new(1))
    );
    assert_eq!(
        chain.panda_checkpoint_at(now).unwrap_err(),
        "Panda checkpoint has unpersisted naive sync votes"
    );
    assert_eq!(
        chain
            .store
            .get_item::<PandaCheckpoint>(&Hash256::repeat_byte(0x50))
            .unwrap()
            .unwrap(),
        prior
    );
    harness.process_sync_contributions(contributions).unwrap();
    let saved = chain.panda_checkpoint_at(now).unwrap().checkpoint;
    assert_eq!(saved.now_ms, prior.now_ms);
    assert_eq!(saved.head_block_root, prior.head_block_root);
    let pool = chain
        .store
        .get_item::<PersistedOperationPool<MainnetEthSpec>>(&Hash256::ZERO)
        .unwrap()
        .unwrap();
    assert!(
        pool.sync_contributions()
            .iter()
            .flat_map(|(_, values)| values)
            .any(|vote| vote.slot == Slot::new(1))
    );
}

#[tokio::test]
async fn checkpoint_uses_protocol_slot_when_the_beacon_head_lags() {
    use beacon_chain::panda_checkpoint::PandaCheckpoint;
    use beacon_chain::test_utils::RelativeSyncCommittee;
    use types::Hash256;

    let harness = BeaconChainHarness::builder(MainnetEthSpec)
        .spec(
            ForkName::Altair
                .make_genesis_spec(MainnetEthSpec::default_spec())
                .into(),
        )
        .deterministic_keypairs(64)
        .fresh_ephemeral_store()
        .build();
    harness
        .add_attested_block_at_slot(Slot::new(1), harness.get_current_state(), &[])
        .await
        .unwrap();
    {
        let head = harness.chain.head_snapshot();
        let messages = harness.make_sync_contributions(
            &head.beacon_state,
            head.beacon_block_root,
            Slot::new(1),
            RelativeSyncCommittee::Current,
        );
        let verified = harness
            .chain
            .verify_sync_committee_message_for_gossip(messages[0].0[0].0.clone(), 0u64.into())
            .unwrap();
        harness
            .chain
            .add_to_naive_sync_aggregation_pool(verified)
            .unwrap();
        // No aggregator delivers a slot-1 contribution. By the slot-3 cut this vote is
        // expired despite the head still being slot 1, and must not prevent checkpointing.
    }
    // Slots 2 and 3 have no blocks. Honest slot-3 sync messages still sign the head-1 root.
    harness.set_current_slot(Slot::new(3));
    let chain = &harness.chain;
    let head = chain.head_snapshot();
    assert_eq!(head.beacon_block.slot(), Slot::new(1));
    let contributions = harness.make_sync_contributions(
        &head.beacon_state,
        head.beacon_block_root,
        Slot::new(3),
        RelativeSyncCommittee::Current,
    );
    let verified = chain
        .verify_sync_committee_message_for_gossip(contributions[0].0[0].0.clone(), 0u64.into())
        .unwrap();
    chain.add_to_naive_sync_aggregation_pool(verified).unwrap();
    harness.process_sync_contributions(contributions).unwrap();
    let naive_slots: std::collections::BTreeSet<_> = chain
        .naive_sync_aggregation_pool
        .read()
        .iter()
        .map(|vote| vote.slot.as_u64())
        .collect();
    assert_eq!(naive_slots, std::collections::BTreeSet::from([1, 3]));
    assert!(
        PersistedOperationPool::from_operation_pool(&chain.op_pool)
            .sync_contributions()
            .iter()
            .flat_map(|(_, values)| values)
            .all(|vote| vote.slot == Slot::new(3))
    );
    let mut next_state = head.beacon_state.clone();
    complete_state_advance(
        &mut next_state,
        Some(head.beacon_state_root()),
        Slot::new(4),
        None,
        &chain.spec,
    )
    .unwrap();
    let expected = chain
        .op_pool
        .get_sync_aggregate(&next_state)
        .unwrap()
        .unwrap();
    assert_eq!(expected.sync_committee_bits.num_set_bits(), 512);
    chain.recompute_head_at_slot(Slot::new(4)).await;
    let now = *chain.slot_clock.genesis_duration()
        + std::time::Duration::from_millis(3 * 12_000 + 11_500);
    chain.slot_clock.set_current_time(now);
    let checkpoint = chain
        .panda_checkpoint_at(now.as_millis() as u64)
        .unwrap()
        .checkpoint;
    assert_eq!(checkpoint.head_slot, 1);
    assert_eq!(checkpoint.fork_choice_slot, 4);
    assert_eq!(checkpoint.now_ms, now.as_millis() as u64);
    let restored = chain
        .store
        .get_item::<PersistedOperationPool<MainnetEthSpec>>(&Hash256::ZERO)
        .unwrap()
        .unwrap()
        .into_operation_pool()
        .unwrap();
    assert_eq!(
        restored.get_sync_aggregate(&next_state).unwrap().unwrap(),
        expected
    );

    chain.op_pool.prune_sync_contributions(Slot::new(5));
    assert_eq!(chain.op_pool.num_sync_contributions(), 0);
    assert_eq!(
        chain
            .panda_checkpoint_at(now.as_millis() as u64)
            .unwrap_err(),
        "Panda checkpoint has unpersisted naive sync votes"
    );
    assert_eq!(
        chain
            .store
            .get_item::<PandaCheckpoint>(&Hash256::repeat_byte(0x50))
            .unwrap()
            .unwrap(),
        checkpoint,
        "missing current votes must refuse save even when the head is older"
    );
}
