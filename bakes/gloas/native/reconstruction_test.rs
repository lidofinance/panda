//! Component coverage only: real KZG verification/reconstruction and checkpoint refusal.
//! The compact signed block fixture comes from the real Geth/Lighthouse blob checkpoint test.
//! Its nonzero blob and every column/proof are recomputed with production KZG. Execution-payload
//! validation and positive cold continuation remain separate real-client checks.
use beacon_chain::AvailabilityProcessingStatus;
use beacon_chain::custody_context::NodeCustodyType;
use beacon_chain::kzg_utils::{blob_to_kzg_commitment, blobs_to_data_column_sidecars_gloas};
use beacon_chain::pending_payload_cache::DataColumnReconstructionResult;
use beacon_chain::test_utils::BeaconChainHarness;
use serde::Deserialize;
use slot_clock::SlotClock;
use ssz::Encode;
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use store::StoreItem;
use types::{
    Blob, DataColumnSidecar, EthSpec, ForkName, Hash256, MainnetEthSpec, SignedBeaconBlock,
};

type E = MainnetEthSpec;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    schema: u64,
    block_ssz: String,
    block_root: Hash256,
    columns_ssz_sha256: String,
}

#[tokio::test]
async fn genuine_partial_columns_reconstruct_without_completing_an_unpersisted_envelope() {
    let fixture: Fixture =
        serde_json::from_str(include_str!("fixtures/panda_blob_checkpoint.json")).unwrap();
    assert_eq!(fixture.schema, 1);
    let spec = ForkName::Gloas.make_genesis_spec(E::default_spec());
    let block_bytes = hex::decode(fixture.block_ssz.strip_prefix("0x").unwrap()).unwrap();
    let block = SignedBeaconBlock::<E>::from_ssz_bytes(&block_bytes, &spec).unwrap();
    let root = block.canonical_root();
    assert_eq!(root, fixture.block_root);
    let slot = block.slot();
    let bid = block
        .message()
        .body()
        .signed_execution_payload_bid()
        .unwrap()
        .clone();
    // No mock EL, signature bypass, injected completed envelope or direct database population.
    // The real-network fixture supplies an already verified bid; this component tests KZG/DA.
    let harness = BeaconChainHarness::builder(E::default())
        .spec(spec.into())
        .deterministic_keypairs(64)
        .node_custody_type(NodeCustodyType::Supernode)
        .fresh_ephemeral_store()
        .build();
    let chain = &harness.chain;
    let mut bytes = vec![0u8; 4096 * 32];
    // Exactly the blob used by blob_checkpoint.ts: 4096 canonical nonzero BLS field elements.
    for index in 0..4096 {
        bytes[index * 32 + 28..index * 32 + 32].copy_from_slice(&(index as u32 + 1).to_be_bytes());
    }
    let blob = Blob::<E>::new(bytes).unwrap();
    let commitment = blob_to_kzg_commitment::<E>(&chain.kzg, &blob).unwrap();
    assert_eq!(bid.message.blob_kzg_commitments.to_vec(), vec![commitment]);
    let columns =
        blobs_to_data_column_sidecars_gloas(&[&blob], root, slot, &chain.kzg, &chain.spec).unwrap();
    assert_eq!(columns.len(), E::number_of_columns());
    assert_eq!(
        hex::encode(ethereum_hashing::hash(&columns.as_ssz_bytes())),
        fixture.columns_ssz_sha256.trim_start_matches("0x"),
        "production KZG columns differ from the actual client's persisted SSZ response",
    );
    let expected: BTreeMap<_, _> = columns
        .iter()
        .map(|column| (*column.index(), column.as_ssz_bytes()))
        .collect();
    assert_eq!(expected.len(), E::number_of_columns());
    let now = *chain.slot_clock.genesis_duration() + Duration::from_millis(11_500);
    chain.slot_clock.set_current_time(now);
    let receipt = chain.panda_checkpoint_at(now.as_millis() as u64).unwrap();
    let original_receipt = receipt.checkpoint.as_store_bytes();
    let original_head = chain.head_snapshot().beacon_block_root;
    let cache = &chain.pending_payload_cache;
    cache.insert_bid(root, Arc::new(bid));

    // Ordinary RPC admission must reject a changed cell before it reaches the verified cache.
    let mut corrupt = serde_json::to_value(columns[0].as_ref()).unwrap();
    let cell = corrupt["column"][0]
        .as_str()
        .unwrap()
        .strip_prefix("0x")
        .unwrap();
    let mut cell = hex::decode(cell).unwrap();
    cell[0] ^= 1;
    corrupt["column"][0] = serde_json::Value::String(format!("0x{}", hex::encode(cell)));
    let corrupt: DataColumnSidecar<E> = serde_json::from_value(corrupt).unwrap();
    assert!(
        chain
            .process_rpc_custody_columns(vec![Arc::new(corrupt)])
            .await
            .is_err()
    );
    assert!(cache.cached_data_column_indexes(&root).unwrap().is_empty());

    let half = E::number_of_columns() / 2;
    let status = chain
        .process_rpc_custody_columns(columns[..half - 1].to_vec())
        .await
        .unwrap();
    assert!(matches!(
        status,
        AvailabilityProcessingStatus::MissingComponents(..)
    ));
    assert!(matches!(
        cache.reconstruct_data_columns(&root).unwrap(),
        DataColumnReconstructionResult::NotStarted("not enough columns")
    ));
    assert!(!cache.is_blob_data_available(&root));
    assert_eq!(
        chain
            .panda_checkpoint_at(now.as_millis() as u64)
            .unwrap_err(),
        "Panda checkpoint payload envelope has not been persisted"
    );

    chain
        .process_rpc_custody_columns(vec![columns[half - 1].clone()])
        .await
        .unwrap();
    assert_eq!(cache.cached_data_column_indexes(&root).unwrap().len(), half);
    // This is the same public BeaconChain path used by the network processor. It runs real
    // KZG reconstruction on Rayon and feeds the recovered columns through availability handling.
    let (status, recovered) = chain
        .reconstruct_data_columns(slot, root)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        status,
        AvailabilityProcessingStatus::MissingComponents(..)
    ));
    assert_eq!(recovered.len(), E::number_of_columns() - half);
    assert!(cache.is_blob_data_available(&root));
    let reconstructed: BTreeMap<_, _> = cache
        .get_data_columns(root)
        .unwrap()
        .iter()
        .map(|column| (*column.index(), column.as_ssz_bytes()))
        .collect();
    assert_eq!(
        reconstructed, expected,
        "recovered cells/proofs differ from real client output"
    );
    assert!(
        matches!(
            cache.reconstruct_data_columns(&root).unwrap(),
            DataColumnReconstructionResult::NotStarted("already started")
        ),
        "the upstream completion flag is sticky even after successful reconstruction"
    );

    // Reconstructed data does not stand in for an executed, persisted payload envelope.
    assert!(chain.store.get_payload_envelope(&root).unwrap().is_none());
    assert_eq!(
        chain
            .panda_checkpoint_at(now.as_millis() as u64)
            .unwrap_err(),
        "Panda checkpoint payload envelope has not been persisted"
    );
    assert_eq!(
        chain
            .store
            .get_item::<beacon_chain::panda_checkpoint::PandaCheckpoint>(&Hash256::repeat_byte(
                0x50
            ))
            .unwrap()
            .unwrap()
            .as_store_bytes(),
        original_receipt
    );
    assert_eq!(chain.head_snapshot().beacon_block_root, original_head);
    assert_eq!(chain.slot_clock.now_duration().unwrap(), now);
}
