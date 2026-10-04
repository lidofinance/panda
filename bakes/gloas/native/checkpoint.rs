//! Explicit cold-resume receipt for an isolated, drained Panda network.
//!
//! The controller closes ingress and completes the slot before parking BN and VC. Native
//! checkpointing additionally rejects incomplete fork-choice/DA work and writes the native
//! continuation records together. It never changes protocol time or manufactures duty marks.
use crate::beacon_chain::{BeaconStore, OP_POOL_DB_KEY};
use crate::custody_context::CustodyContextSsz;
use crate::persisted_custody::{CUSTODY_DB_KEY, PersistedCustody};
use crate::{BeaconChain, BeaconChainTypes};
use fork_choice::ForkChoiceStore;
use operation_pool::PersistedOperationPool;
use serde::Serialize;
use slot_clock::SlotClock;
use ssz::{Decode, Encode};
use ssz_derive::{Decode, Encode};
use store::{DBColumn, KeyValueStore, KeyValueStoreOp, StoreItem};
use types::{Checkpoint, Hash256};

const KEY: Hash256 = Hash256::repeat_byte(0x50);
const MAGIC: &[u8] = b"PANDACHECKPOINT\0";

#[derive(Clone, Debug, PartialEq, Encode, Decode, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PandaCheckpoint {
    pub abi: u64,
    pub now_ms: u64,
    pub head_slot: u64,
    pub head_block_root: Hash256,
    pub head_state_root: Hash256,
    pub fork_choice_slot: u64,
    pub justified: Checkpoint,
    pub finalized: Checkpoint,
    pub op_pool_hash: Hash256,
    pub fork_choice_hash: Hash256,
    pub custody_hash: Hash256,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointReceipt {
    #[serde(flatten)]
    pub checkpoint: PandaCheckpoint,
    pub checkpoint_hash: Hash256,
}

fn hash(bytes: &[u8]) -> Hash256 {
    Hash256::from_slice(&ethereum_hashing::hash(bytes))
}
fn failure(error: impl std::fmt::Debug) -> String {
    format!("Panda checkpoint: {error:?}")
}

impl StoreItem for PandaCheckpoint {
    fn db_column() -> DBColumn {
        DBColumn::BeaconChain
    }
    fn as_store_bytes(&self) -> Vec<u8> {
        let body = self.as_ssz_bytes();
        [MAGIC, hash(&body).as_slice(), &body].concat()
    }
    fn from_store_bytes(bytes: &[u8]) -> Result<Self, store::Error> {
        let fail = || ssz::DecodeError::BytesInvalid("invalid Panda checkpoint".into());
        if !bytes.starts_with(MAGIC) || bytes.len() < MAGIC.len() + 32 {
            return Err(fail().into());
        }
        let body = &bytes[MAGIC.len() + 32..];
        if hash(body).as_slice() != &bytes[MAGIC.len()..MAGIC.len() + 32] {
            return Err(fail().into());
        }
        let value = Self::from_ssz_bytes(body)?;
        if value.abi != 1 {
            return Err(fail().into());
        }
        Ok(value)
    }
}

impl PandaCheckpoint {
    fn receipt(self) -> CheckpointReceipt {
        let checkpoint_hash = hash(&self.as_store_bytes());
        CheckpointReceipt {
            checkpoint: self,
            checkpoint_hash,
        }
    }

    /// Called before the builder may reset execution statuses or write any startup records.
    pub fn validate_store<T: BeaconChainTypes>(
        store: &BeaconStore<T>,
        now_ms: u64,
    ) -> Result<Self, String> {
        let checkpoint = store
            .get_item::<Self>(&KEY)
            .map_err(failure)?
            .ok_or("Panda checkpoint missing; refusing fresh initialization")?;
        let receipt_bytes = checkpoint.as_store_bytes();
        for (name, bytes) in [
            (
                "cold",
                store
                    .cold_db
                    .get_bytes(DBColumn::BeaconChain, KEY.as_slice())
                    .map_err(failure)?,
            ),
            (
                "blobs",
                store
                    .blobs_db
                    .get_bytes(DBColumn::BeaconChain, KEY.as_slice())
                    .map_err(failure)?,
            ),
        ] {
            if bytes.as_deref() != Some(receipt_bytes.as_slice()) {
                return Err(format!(
                    "Panda checkpoint {name} database missing or from a different cut"
                ));
            }
        }
        if checkpoint.now_ms != now_ms {
            return Err("Panda checkpoint protocol time mismatch".into());
        }
        for (column, expected) in [
            (DBColumn::OpPool, checkpoint.op_pool_hash),
            (DBColumn::ForkChoice, checkpoint.fork_choice_hash),
            (DBColumn::CustodyContext, checkpoint.custody_hash),
        ] {
            let bytes = store
                .hot_db
                .get_bytes(column, Hash256::ZERO.as_slice())
                .map_err(failure)?
                .ok_or_else(|| format!("Panda checkpoint required record missing: {column:?}"))?;
            if hash(&bytes) != expected {
                return Err(format!("Panda checkpoint record mismatch: {column:?}"));
            }
        }
        let pool = store
            .get_item::<PersistedOperationPool<T::EthSpec>>(&OP_POOL_DB_KEY)
            .map_err(failure)?
            .ok_or("Panda checkpoint operation pool missing")?;
        if !pool.supports_ptc_resume() {
            return Err("Panda checkpoint requires versioned PTC pool".into());
        }
        pool.into_operation_pool().map_err(failure)?;
        let block = store
            .get_blinded_block(&checkpoint.head_block_root)
            .map_err(failure)?
            .ok_or("Panda checkpoint head block missing")?;
        if block.slot().as_u64() != checkpoint.head_slot
            || block.state_root() != checkpoint.head_state_root
        {
            return Err("Panda checkpoint head block mismatch".into());
        }
        if block.fork_name_unchecked().gloas_enabled()
            && checkpoint.head_slot > 0
            && store
                .get_payload_envelope(&checkpoint.head_block_root)
                .map_err(failure)?
                .is_none()
        {
            return Err("Panda checkpoint head payload envelope missing".into());
        }
        let state = store
            .get_state(&checkpoint.head_state_root, Some(block.slot()), false)
            .map_err(failure)?
            .ok_or("Panda checkpoint head state missing")?;
        if state.slot() != block.slot() {
            return Err("Panda checkpoint head state mismatch".into());
        }
        Ok(checkpoint)
    }
}

impl<T: BeaconChainTypes> BeaconChain<T> {
    pub fn panda_checkpoint_status(&self) -> Result<CheckpointReceipt, String> {
        if slot_clock::controlled::is_parked() && !slot_clock::controlled::is_quiescent() {
            return Err("Panda checkpoint startup/background work has not drained".into());
        }
        let checkpoint = self
            .store
            .get_item::<PandaCheckpoint>(&KEY)
            .map_err(failure)?
            .ok_or("Panda checkpoint missing")?;
        let head = self.head_snapshot();
        if self
            .slot_clock
            .now_duration()
            .map(|time| time.as_millis() as u64)
            != Some(checkpoint.now_ms)
            || head.beacon_block_root != checkpoint.head_block_root
            || head.beacon_state_root() != checkpoint.head_state_root
        {
            return Err("Panda checkpoint no longer matches running chain".into());
        }
        let fc = self.canonical_head.fork_choice_read_lock();
        if fc.fc_store().get_current_slot().as_u64() != checkpoint.fork_choice_slot
            || fc.justified_checkpoint() != checkpoint.justified
            || fc.finalized_checkpoint() != checkpoint.finalized
        {
            return Err("Panda checkpoint no longer matches running fork choice".into());
        }
        let pool = self
            .store
            .get_item::<PersistedOperationPool<T::EthSpec>>(&OP_POOL_DB_KEY)
            .map_err(failure)?
            .ok_or("Panda checkpoint operation pool missing")?;
        let current = PersistedOperationPool::from_operation_pool(&self.op_pool);
        if hash(&pool.as_store_bytes()) != checkpoint.op_pool_hash
            || pool.payload_attestation_messages().map_err(failure)?
                != current.payload_attestation_messages().map_err(failure)?
            || pool.into_operation_pool().map_err(failure)? != self.op_pool
        {
            return Err("Panda checkpoint no longer matches running operation pool".into());
        }
        Ok(checkpoint.receipt())
    }

    pub fn panda_checkpoint(&self) -> Result<CheckpointReceipt, String> {
        if !slot_clock::controlled::is_quiescent() {
            return Err("Panda checkpoint requires parked idle clock".into());
        }
        self.panda_checkpoint_at(
            self.slot_clock
                .now_duration()
                .ok_or("clock unavailable")?
                .as_millis() as u64,
        )
    }

    /// Native component entrypoint. The HTTP entrypoint also requires a parked controlled clock.
    pub fn panda_checkpoint_at(&self, now_ms: u64) -> Result<CheckpointReceipt, String> {
        if self
            .slot_clock
            .now_duration()
            .map(|time| time.as_millis() as u64)
            != Some(now_ms)
        {
            return Err("Panda checkpoint time does not match native clock".into());
        }
        if self.canonical_head.fork_choice_poisoned() {
            return Err("Panda checkpoint fork choice poisoned".into());
        }
        let protocol_slot = self.slot().map_err(failure)?.as_u64();
        let genesis_ms = self.slot_clock.genesis_duration().as_millis() as u64;
        let slot_ms = self.slot_clock.slot_duration().as_millis() as u64;
        let genesis_cut = now_ms == genesis_ms && protocol_slot == 0;
        if !genesis_cut && (now_ms - genesis_ms) % slot_ms != slot_ms * 23 / 24 {
            return Err(
                "Panda checkpoint requires a completed slot tail; time will not be advanced".into(),
            );
        }
        // State-advance jobs and signing are parked; controller drained verified HTTP import.
        let head = self.head_snapshot();
        let fc = self.canonical_head.fork_choice_read_lock();
        let fork_choice_slot = fc.fc_store().get_current_slot().as_u64();
        // Fresh startup is already at the genesis tail, after the timer's 9s preparation phase.
        // No slot-zero duties/lookahead ran, so that initial cut legitimately retains FC slot0.
        let initial_genesis =
            protocol_slot == 0 && head.beacon_block.slot().as_u64() == 0 && fork_choice_slot == 0;
        if fork_choice_slot != protocol_slot + u64::from(!genesis_cut) && !initial_genesis {
            return Err("Panda checkpoint fork-choice cut incomplete".into());
        }
        if !fc.queued_attestations().is_empty() {
            return Err("Panda checkpoint has queued fork-choice votes".into());
        }
        for root in self
            .data_availability_checker
            .checkpoint_roots()
            .map_err(failure)?
        {
            if self
                .store
                .get_blinded_block(&root)
                .map_err(failure)?
                .is_none()
            {
                return Err("Panda checkpoint available block has not been persisted".into());
            }
        }
        for root in self.pending_payload_cache.checkpoint_roots() {
            if self
                .store
                .get_payload_envelope(&root)
                .map_err(failure)?
                .is_none()
            {
                return Err("Panda checkpoint payload envelope has not been persisted".into());
            }
        }
        for root in self.pending_payload_envelopes.read().checkpoint_roots() {
            if self
                .store
                .get_payload_envelope(&root)
                .map_err(failure)?
                .is_none()
            {
                return Err("Panda checkpoint has unpublished local payload envelope".into());
            }
        }
        if head.beacon_block.fork_name_unchecked().gloas_enabled()
            && head.beacon_block.slot().as_u64() > 0
            && self
                .store
                .get_payload_envelope(&head.beacon_block_root)
                .map_err(failure)?
                .is_none()
        {
            return Err("Panda checkpoint head payload envelope incomplete".into());
        }
        // Reuse normal verified-vote transfer. No extra block and no new signatures.
        self.transfer_naive_votes_to_op_pool().map_err(failure)?;
        let pool = PersistedOperationPool::from_operation_pool(&self.op_pool);
        // The next block selects sync votes from its previous slot, i.e. protocol_slot.
        // Naive storage retains three slots, while normal finalization may already prune
        // expired contributions from the operation pool. Those older votes cannot affect
        // continuation. Current and future votes (admitted with gossip clock tolerance)
        // must still have a durable contribution; do not derive this bound from a lagging head.
        for naive in self
            .naive_sync_aggregation_pool
            .read()
            .iter()
            .filter(|vote| vote.slot.as_u64() >= protocol_slot)
        {
            let covered = pool
                .sync_contributions()
                .iter()
                .flat_map(|(_, values)| values)
                .any(|saved| {
                    saved.slot == naive.slot
                        && saved.beacon_block_root == naive.beacon_block_root
                        && saved.subcommittee_index == naive.subcommittee_index
                        && naive
                            .aggregation_bits
                            .iter()
                            .zip(saved.aggregation_bits.iter())
                            .all(|(needed, present)| !needed || present)
                });
            if !covered {
                return Err("Panda checkpoint has unpersisted naive sync votes".into());
            }
        }
        let custody = PersistedCustody(CustodyContextSsz::from(self.custody_context.as_ref()));
        let fc_op = Self::persist_fork_choice_in_batch_standalone(&fc, self.store.get_config())
            .map_err(failure)?;
        let KeyValueStoreOp::PutKeyValue(_, _, ref fc_bytes) = fc_op else {
            return Err("invalid fork-choice operation".into());
        };
        let checkpoint = PandaCheckpoint {
            abi: 1,
            now_ms,
            head_slot: head.beacon_block.slot().as_u64(),
            head_block_root: head.beacon_block_root,
            head_state_root: head.beacon_state_root(),
            fork_choice_slot: fc.fc_store().get_current_slot().as_u64(),
            justified: fc.justified_checkpoint(),
            finalized: fc.finalized_checkpoint(),
            op_pool_hash: hash(&pool.as_store_bytes()),
            fork_choice_hash: hash(fc_bytes),
            custody_hash: hash(&custody.as_store_bytes()),
        };
        // Required sentinels in every physical database prevent a missing cold/blob DB from
        // being silently recreated as empty by the ordinary database opener. A failed multi-DB
        // save has no ACK; mixed cuts are rejected on restore.
        let receipt_bytes = checkpoint.as_store_bytes();
        self.store
            .cold_db
            .put_bytes_sync(DBColumn::BeaconChain, KEY.as_slice(), &receipt_bytes)
            .map_err(failure)?;
        self.store
            .blobs_db
            .put_bytes_sync(DBColumn::BeaconChain, KEY.as_slice(), &receipt_bytes)
            .map_err(failure)?;
        self.store
            .hot_db
            .do_atomically(vec![
                fc_op,
                pool.as_kv_store_op(OP_POOL_DB_KEY),
                custody.as_kv_store_op(CUSTODY_DB_KEY),
                checkpoint.as_kv_store_op(KEY),
            ])
            .map_err(failure)?;
        // An ACK means all three backing databases flushed and exact bytes read back successfully.
        self.store.blobs_db.sync().map_err(failure)?;
        self.store.cold_db.sync().map_err(failure)?;
        self.store.hot_db.sync().map_err(failure)?;
        let saved = PandaCheckpoint::validate_store::<T>(&self.store, now_ms)?;
        if saved != checkpoint {
            return Err("Panda checkpoint read-back mismatch".into());
        }
        Ok(saved.receipt())
    }
}
