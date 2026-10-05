"""Panda checkpoint changes for the exact pinned Gloas source tree."""
from pathlib import Path
import shutil
import re


def apply(root):
    root = Path(root)
    here = Path(__file__).resolve().parent

    def edit(path, old, new, count=1):
        file = root / path
        text = file.read_text()
        if text.count(old) != count:
            raise RuntimeError(f'{path}: checkpoint patch expected {count} occurrences of {old!r}')
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

    shutil.copyfile(here / 'native/checkpoint.rs', root / 'beacon_node/beacon_chain/src/panda_checkpoint.rs')
    edit('beacon_node/beacon_chain/src/lib.rs', 'mod beacon_chain;',
         'mod beacon_chain;\npub mod panda_checkpoint;')
    edit('beacon_node/beacon_chain/src/beacon_chain.rs',
         '''    pub fn persist_op_pool(&self) -> Result<(), Error> {
        let _timer = metrics::start_timer(&metrics::PERSIST_OP_POOL);

        // Block production''',
         '''    pub fn persist_op_pool(&self) -> Result<(), Error> {
        let _timer = metrics::start_timer(&metrics::PERSIST_OP_POOL);
        self.transfer_naive_votes_to_op_pool()?;
        self.store.put_item(
            &OP_POOL_DB_KEY,
            &PersistedOperationPool::from_operation_pool(&self.op_pool),
        )?;
        Ok(())
    }

    pub(crate) fn transfer_naive_votes_to_op_pool(&self) -> Result<(), Error> {
        // Block production''')
    edit('beacon_node/beacon_chain/src/beacon_chain.rs',
         '''        self.store.put_item(
            &OP_POOL_DB_KEY,
            &PersistedOperationPool::from_operation_pool(&self.op_pool),
        )?;

        Ok(())''', '''        Ok(())''')
    edit('beacon_node/beacon_chain/src/pending_payload_envelopes.rs',
         '    /// Returns the number of pending envelopes in the cache.',
         '''    pub fn checkpoint_roots(&self) -> Vec<Hash256> {
        self.envelopes.keys().copied().collect()
    }

    /// Returns the number of pending envelopes in the cache.''')
    edit('beacon_node/beacon_chain/src/pending_payload_cache/mod.rs',
         '    // ── Internal helpers ──',
         '''    /// Cache entries are retained after import; the caller checks their persisted envelope.
    pub fn checkpoint_roots(&self) -> Vec<Hash256> {
        self.availability_cache.read().iter().map(|(root, _)| *root).collect()
    }

    // ── Internal helpers ──''')
    # Validate before the builder chooses resume vs genesis, so a missing DB cannot fall back.
    edit('beacon_node/beacon_chain/src/builder.rs',
         '''            .ok_or("store_contains_beacon_chain requires a store.")?;

        Ok(store''',
         '''            .ok_or("store_contains_beacon_chain requires a store.")?;

        if std::env::var("PANDA_REQUIRE_CHECKPOINT").as_deref() == Ok("1") {
            if !slot_clock::controlled::is_parked() {
                return Err("Panda checkpoint resume requires parked startup".into());
            }
            let now_ms = slot_clock::controlled::now().ok_or("Panda clock unavailable")?.as_millis() as u64;
            crate::panda_checkpoint::PandaCheckpoint::validate_store::<Witness<TSlotClock, E, THotStore, TColdStore>>(&store, now_ms)?;
        }

        Ok(store''')
    edit('beacon_node/beacon_chain/src/builder.rs',
         '''    pub fn genesis_state(mut self, mut beacon_state: BeaconState<E>) -> Result<Self, String> {''',
         '''    pub fn genesis_state(mut self, mut beacon_state: BeaconState<E>) -> Result<Self, String> {
        if std::env::var("PANDA_REQUIRE_CHECKPOINT").as_deref() == Ok("1") {
            return Err("Panda checkpoint resume cannot initialize genesis".into());
        }''')
    # The same endpoint reads back the persisted receipt after a parked startup.
    api = '''    let panda_checkpoint_path = warp::path("lighthouse")
        .and(warp::path("panda"))
        .and(warp::path("checkpoint"))
        .and(warp::path::end())
        .and(task_spawner_filter.clone())
        .and(chain_filter.clone());
    let post_panda_checkpoint = panda_checkpoint_path.clone().then(
        |task_spawner: TaskSpawner<T::EthSpec>, chain: Arc<BeaconChain<T>>| {
            task_spawner.blocking_json_task(Priority::P0, move || {
                chain.panda_checkpoint().map_err(warp_utils::reject::custom_bad_request)
            })
        });
    let get_panda_checkpoint = panda_checkpoint_path.then(
        |task_spawner: TaskSpawner<T::EthSpec>, chain: Arc<BeaconChain<T>>| {
            task_spawner.blocking_json_task(Priority::P0, move || {
                chain.panda_checkpoint_status().map_err(warp_utils::reject::custom_bad_request)
            })
        });

'''
    edit('beacon_node/http_api/src/lib.rs', '    // POST lighthouse/finalize', api + '    // POST lighthouse/finalize')
    edit('beacon_node/http_api/src/lib.rs', '                .uor(get_debug_fork_choice)',
         '                .uor(get_debug_fork_choice)\n                .uor(get_panda_checkpoint)')
    edit('beacon_node/http_api/src/lib.rs',
         '        .boxed()\n        .uor(\n            warp::post().and(',
         """        .boxed()
        .uor(
            warp::post()
            .and(warp::path::full().and_then(|path: warp::path::FullPath| async move {
                // Checkpoint writes are the only POST allowed after admission is parked.
                if path.as_str() == "/lighthouse/panda/checkpoint" { return Ok(None); }
                slot_clock::controlled::try_work().map(Some).ok_or_else(|| warp_utils::reject::custom_bad_request("Panda native writes are parked".into()))
            }))
            .and(""")
    edit('beacon_node/http_api/src/lib.rs',
         """                    .uor(post_lighthouse_custody_backfill)
                    .recover(warp_utils::reject::handle_rejection),
            ),""",
         """                    .uor(post_lighthouse_custody_backfill)
                    .uor(post_panda_checkpoint)
                    // Recover only after every POST path has had a chance to match.
                    .recover(warp_utils::reject::handle_rejection),
            ).map(|guard: Option<slot_clock::controlled::WorkGuard>, reply| { drop(guard); reply }),""")
    # HTTP cancellation only drops the response receiver. The admitted guard must also be
    # owned by actual detached work, including attestation reprocessing queued for an envelope.
    edit('beacon_node/http_api/src/lib.rs',
         '''    let task_spawner_filter = warp::any()
        .map(move || TaskSpawner::new(beacon_processor_send.clone()))
        .boxed();''',
         '''    let task_spawner_filter = warp::method()
        .and(warp::path::full())
        .and_then(move |method: warp::http::Method, path: warp::path::FullPath| {
            let spawner = TaskSpawner::new(beacon_processor_send.clone());
            async move { spawner.panda_request(method.as_str(), path.as_str()) }
        })
        .boxed();''')
    edit('beacon_node/http_api/src/task_spawner.rs',
         '    beacon_processor_send: Option<BeaconProcessorSend<E>>,',
         '    beacon_processor_send: Option<BeaconProcessorSend<E>>,\n    panda_work: Option<std::sync::Arc<slot_clock::controlled::WorkGuard>>,')
    edit('beacon_node/http_api/src/task_spawner.rs',
         '        Self {\n            beacon_processor_send,\n        }',
         '        Self {\n            beacon_processor_send,\n            panda_work: None,\n        }')
    edit('beacon_node/http_api/src/task_spawner.rs',
         '    /// Executes a "blocking" (non-async) task which returns an arbitrary value.',
         '''    pub fn panda_request(self, method: &str, path: &str) -> Result<Self, warp::Rejection> {
        let block_production = ["v1", "v2", "v3", "v4"].iter().any(|version| {
            path.starts_with(&format!("/eth/{version}/validator/blocks/"))
                || path.starts_with(&format!("/eth/{version}/validator/blinded_blocks/"))
        });
        if (method == "POST" && path != "/lighthouse/panda/checkpoint")
            || (method == "GET" && block_production)
        {
            self.panda_write()
        } else {
            Ok(self)
        }
    }

    pub fn panda_write(mut self) -> Result<Self, warp::Rejection> {
        self.panda_work = Some(std::sync::Arc::new(slot_clock::controlled::try_work()
            .ok_or_else(|| warp_utils::reject::custom_bad_request("Panda native writes are parked".into()))?));
        Ok(self)
    }

    /// Inherit admission; never acquire a nested guard after parking has closed admission.
    pub fn panda_reprocess<F, T>(&self, func: F) -> Box<dyn FnOnce() -> T + Send + Sync + 'static>
    where F: FnOnce() -> T + Send + Sync + 'static {
        let guard = self.panda_work.clone();
        Box::new(move || { let _guard = guard; func() })
    }

    /// Executes a "blocking" (non-async) task which returns an arbitrary value.''')
    edit('beacon_node/http_api/src/task_spawner.rs',
         '''        T: Send + 'static,
    {
        if let Some(beacon_processor_send)''',
         '''        T: Send + 'static,
    {
        let func = self.panda_reprocess(func);
        if let Some(beacon_processor_send)''')
    edit('beacon_node/http_api/src/task_spawner.rs',
         '''    ) -> Result<Response, warp::Rejection> {
        if let Some(beacon_processor_send)''',
         '''    ) -> Result<Response, warp::Rejection> {
        let guard = self.panda_work.clone();
        let func = async move { let _guard = guard; func.await };
        if let Some(beacon_processor_send)''')
    edit('beacon_node/http_api/src/publish_attestations.rs',
         '                            let reprocess_fn = move || {',
         '                            let reprocess_fn = task_spawner.panda_reprocess(move || {', 2)
    edit('beacon_node/http_api/src/publish_attestations.rs',
         '''                                let _ = tx.send(result);
                            };''',
         '''                                let _ = tx.send(result);
                            });''', 2)
    shutil.copyfile(here / 'native/admission_test.rs', root / 'beacon_node/http_api/tests/panda_checkpoint_admission.rs')
    with (root / 'beacon_node/http_api/Cargo.toml').open('a') as target:
        target.write('\n[[test]]\nname = "panda_checkpoint_admission"\npath = "tests/panda_checkpoint_admission.rs"\n')
    shutil.copyfile(here / 'native/vc_admission.rs', root / 'validator_client/http_api/src/panda_admission.rs')
    edit('validator_client/http_api/src/lib.rs', 'mod create_signed_voluntary_exit;',
         'mod create_signed_voluntary_exit;\nmod panda_admission;')
    edit('validator_client/http_api/src/lib.rs',
         'use warp_utils::task::{blocking_json_task, blocking_response_task};',
         'use warp_utils::task::blocking_json_task;')
    vc_api = root / 'validator_client/http_api/src/lib.rs'
    text = vc_api.read_text()
    routes = list(re.finditer(r'^    let ((?:post|delete|patch|put)_\w+) =', text, re.MULTILINE))
    if len(routes) != 20:
        raise RuntimeError('VC mutation route inventory changed; audit checkpoint admission')
    for route in reversed(routes):
        end = text.find('\n    let ', route.end())
        if end < 0:
            raise RuntimeError('VC mutation route boundary missing')
        chunk = text[route.start():end]
        if chunk.count('blocking_json_task(') + chunk.count('blocking_response_task(') != 1:
            raise RuntimeError(f'VC mutation task changed: {route.group(1)}')
        chunk = chunk.replace('blocking_json_task(', 'panda_admission::blocking_json_task(')
        chunk = chunk.replace('blocking_response_task(', 'panda_admission::blocking_response_task(')
        text = text[:route.start()] + chunk + text[end:]
    vc_api.write_text(text)
    # This one route mutates candidates asynchronously before its final JSON serialization.
    edit('validator_client/http_api/src/lib.rs',
         '''                  block_service: BlockService<LighthouseValidatorStore<T, E>, T>| async move {
                // The error''',
         '''                  block_service: BlockService<LighthouseValidatorStore<T, E>, T>| async move {
                let Some(_panda_work) = slot_clock::controlled::try_work() else {
                    return convert_rejection::<Infallible>(Err(warp_utils::reject::custom_bad_request(
                        "Panda validator writes are parked".into()))).await;
                };
                // The error''')
    edit('validator_client/src/lib.rs', '        // Wait until genesis has occurred.',
         '''        // The API and saved clock are readable while duties remain parked.
        if slot_clock::controlled::is_parked() { slot_clock::controlled::mark("parked_ready", 0); }
        slot_clock::controlled::wait_until_running().await;

        // Wait until genesis has occurred.''')
    edit('validator_client/signing_method/Cargo.toml', '[dependencies]',
         '[dependencies]\nslot_clock = { workspace = true }')
    with (root / 'validator_client/signing_method/Cargo.toml').open('a') as target:
        target.write('\n[dev-dependencies]\ntokio = { workspace = true }\nnum_cpus = { workspace = true }\n')
    (root / 'validator_client/signing_method/tests').mkdir(exist_ok=True)
    shutil.copyfile(here / 'native/signing_admission_test.rs', root / 'validator_client/signing_method/tests/panda_signing_admission.rs')
    lock = root / 'Cargo.lock'
    text = lock.read_text()
    start = text.index('name = "signing_method"')
    end = text.index('[[package]]', start)
    section = text[start:end].replace(' "task_executor",', ' "slot_clock",\n "task_executor",\n "tokio",', 1).replace(' "lockfile",', ' "lockfile",\n "num_cpus",', 1)
    lock.write_text(text[:start] + section + text[end:])
    edit('validator_client/signing_method/src/lib.rs',
         '''        match self {
            SigningMethod::LocalKeystore { voting_keypair, .. } => {''',
         '''        let _panda_signing = slot_clock::controlled::try_work().ok_or(Error::ShuttingDown)?;
        match self {
            SigningMethod::LocalKeystore { voting_keypair, .. } => {''')
    edit('validator_client/signing_method/src/lib.rs',
         '''                    .spawn_blocking_with_rayon_async(RayonPoolType::HighPriority, move || {
                        voting_keypair.sk.sign(signing_root)''',
         '''                    .spawn_blocking_with_rayon_async(RayonPoolType::HighPriority, move || {
                        let _panda_signing = _panda_signing;
                        voting_keypair.sk.sign(signing_root)''')
    edit('beacon_node/timer/src/lib.rs', '            if let Err(error) = beacon_chain.prepare_controlled_skip().await {',
         '            let _panda_work = slot_clock::controlled::work().await;\n            if let Err(error) = beacon_chain.prepare_controlled_skip().await {')
    edit('beacon_node/beacon_chain/src/state_advance_timer.rs',
         '    loop {\n        let Some(duration_to_next_slot)',
         '    loop {\n        slot_clock::controlled::wait_until_running().await;\n        let Some(duration_to_next_slot)')
    edit('beacon_node/beacon_chain/src/state_advance_timer.rs',
         '        if !is_running.lock() {',
         '        let panda_state_work = slot_clock::controlled::work().await;\n        if !is_running.lock() {')
    edit('beacon_node/beacon_chain/src/state_advance_timer.rs',
         '                    match advance_head(&beacon_chain) {',
         '                    let _panda_work = panda_state_work;\n                    match advance_head(&beacon_chain) {')
    edit('beacon_node/beacon_chain/src/state_advance_timer.rs',
         '        let beacon_chain = beacon_chain.clone();\n        let next_slot = current_slot + 1;',
         '        let panda_fc_work = slot_clock::controlled::work().await;\n        let beacon_chain = beacon_chain.clone();\n        let next_slot = current_slot + 1;')
    edit('beacon_node/beacon_chain/src/state_advance_timer.rs',
         '                // Don\'t run fork choice during sync.',
         '                let _panda_work = panda_fc_work;\n                // Don\'t run fork choice during sync.')

    # An acknowledged checkpoint is already a coherent durable batch; Drop must not overwrite
    # it with independently sampled records after a clean parked stop.
    edit('beacon_node/beacon_chain/src/beacon_chain.rs',
         '    fn drop(&mut self) {\n        if self.canonical_head.fork_choice_poisoned() {',
         """    fn drop(&mut self) {
        if slot_clock::controlled::is_parked() && self.panda_checkpoint_status().is_ok() {
            info!("Preserving acknowledged Panda checkpoint on shutdown");
            return;
        }
        if self.canonical_head.fork_choice_poisoned() {""")
    edit('beacon_node/beacon_chain/src/builder.rs',
         '                .unwrap_or_else(OperationPool::new),',
         '                .ok_or("Persisted operation pool missing; refusing lossy cold resume")?,')
    edit('beacon_node/beacon_chain/src/builder.rs',
         '''        if beacon_chain.store.get_config().prune_payloads {
            let store = beacon_chain.store.clone();''',
         '''        if beacon_chain.store.get_config().prune_payloads {
            let panda_prune = slot_clock::controlled::background_work();
            let store = beacon_chain.store.clone();''')
    edit('beacon_node/beacon_chain/src/builder.rs',
         '''                move || {
                    if let Err(e) = store.try_prune_execution_payloads(false) {''',
         '''                move || {
                    let _panda_prune = panda_prune;
                    if let Err(e) = store.try_prune_execution_payloads(false) {''')

    edit('beacon_node/beacon_chain/src/state_advance_timer.rs',
         '        } else {\n            warn!(\n                msg = "system resources may be overloaded",',
         '        } else {\n            drop(panda_state_work);\n            warn!(\n                msg = "system resources may be overloaded",')
    edit('beacon_node/beacon_chain/src/proposer_prep_service.rs',
         '                let inner_chain = chain.clone();',
         '                let panda_work = slot_clock::controlled::work().await;\n                let inner_chain = chain.clone();')
    edit('beacon_node/beacon_chain/src/proposer_prep_service.rs',
         '                    async move {\n                        if let Ok(current_slot)',
         '                    async move {\n                        let _panda_work = panda_work;\n                        if let Ok(current_slot)')
    edit('beacon_node/beacon_chain/src/data_availability_checker/overflow_lru_cache.rs',
         '    /// Number of pending component entries in memory in the cache.',
         '''    pub fn checkpoint_roots(&self) -> Vec<Hash256> {
        self.critical.read().iter().map(|(root, _)| *root).collect()
    }

    /// Number of pending component entries in memory in the cache.''')
    edit('beacon_node/beacon_chain/src/partial_data_column_assembler.rs',
         '    pub fn new(capacity: usize, disable_get_blobs: bool) -> Self {',
         '''    pub fn checkpoint_is_empty(&self) -> bool { self.assemblies.read().is_empty() }

    pub fn new(capacity: usize, disable_get_blobs: bool) -> Self {''')
    edit('beacon_node/beacon_chain/src/data_availability_checker.rs',
         '    /// Collects metrics from the data availability checker.',
         '''    pub fn checkpoint_roots(&self) -> Result<Vec<Hash256>, AvailabilityCheckError> {
        if self.partial_assembler.as_ref().is_some_and(|assembler| !assembler.checkpoint_is_empty()) {
            return Err(AvailabilityCheckError::Unexpected("Panda checkpoint has unsupported Fulu partial-column work".into()));
        }
        Ok(self.availability_cache.checkpoint_roots())
    }

    /// Collects metrics from the data availability checker.''')
