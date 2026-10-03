"""Panda checkpoint changes for the exact pinned Gloas source tree."""
from pathlib import Path
import shutil


def apply(root):
    root = Path(root)
    here = Path(__file__).resolve().parent

    def edit(path, old, new):
        file = root / path
        text = file.read_text()
        if text.count(old) != 1:
            raise RuntimeError(f'{path}: checkpoint patch expected one occurrence of {old!r}')
        file.write_text(text.replace(old, new))

    shutil.copyfile(here / 'native/persistence.rs', root / 'beacon_node/operation_pool/src/persistence.rs')
    edit('beacon_node/beacon_chain/src/beacon_chain.rs',
         '''    pub fn persist_op_pool(&self) -> Result<(), Error> {
        let _timer = metrics::start_timer(&metrics::PERSIST_OP_POOL);

        self.store.put_item(''',
         '''    pub fn persist_op_pool(&self) -> Result<(), Error> {
        let _timer = metrics::start_timer(&metrics::PERSIST_OP_POOL);

        // Block production normally transfers these verified votes to the operation pool.
        // A cold restart may happen before the next proposal, including when no validator
        // was selected as aggregator. Complete that same transfer before serializing.
        // Propagate errors: silently omitting a vote would change the next block.
        let mut state = self.head_snapshot().beacon_state.clone();
        state.build_all_committee_caches(&self.spec)?;
        for attestation in self.naive_aggregation_pool.read().iter() {
            let attesting_indices = get_attesting_indices_from_state(&state, attestation.to_ref())?;
            self.op_pool.insert_attestation(attestation.clone(), attesting_indices)?;
        }

        self.store.put_item(''')
    edit('beacon_node/operation_pool/src/lib.rs', '    PayloadAttestationBitError,',
         '    PayloadAttestationBitError,\n    MalformedPersistedPayloadAttestations,')
    edit('beacon_node/operation_pool/Cargo.toml', '[dependencies]',
         '[dependencies]\nethereum_hashing = { workspace = true }')
    lock = root / 'Cargo.lock'
    text = lock.read_text()
    start = text.index('name = "operation_pool"')
    end = text.index('[[package]]', start)
    package = text[start:end].replace(' "ethereum_ssz",', ' "ethereum_hashing",\n "ethereum_ssz",', 1)
    lock.write_text(text[:start] + package + text[end:])
    edit('beacon_node/beacon_chain/tests/schema_stability.rs',
         'assert!(matches!(op_pool, PersistedOperationPool::V20(_)));\n    assert_eq!(op_pool.ssz_bytes_len(), 28);\n    assert_eq!(op_pool.as_store_bytes().len(), 28);',
         'assert!(op_pool.supports_ptc_resume());\n    assert_eq!(op_pool.ssz_bytes_len(), 32);\n    assert_eq!(op_pool.as_store_bytes().len(), 77);')
    shutil.copyfile(here / 'native/restart_test.rs', root / 'beacon_node/beacon_chain/tests/panda_restart.rs')
    cargo = root / 'beacon_node/beacon_chain/Cargo.toml'
    cargo.write_text(cargo.read_text() + '\n[[test]]\nname = "panda_restart"\npath = "tests/panda_restart.rs"\n')
