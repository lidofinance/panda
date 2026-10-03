"""Maintainer helper for the pinned Gloas Lighthouse commit. Fails on upstream drift."""
from pathlib import Path
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'shared'))
from patch_bls import apply as patch_bls
from patch_direct_sync import apply as patch_direct_sync

root = Path(sys.argv[1] if len(sys.argv) > 1 else '.cache/upstream/lighthouse-gloas')
patch_bls(root)
def edit(path, old, new, count=1):
    file = root / path
    text = file.read_text()
    if text.count(old) != count:
        raise RuntimeError(f'{path}: expected {count} occurrences of {old!r}, got {text.count(old)}')
    file.write_text(text.replace(old, new))

def finish(path, fn, marker, expr):
    file = root / path
    text = file.read_text()
    start = text.index('    async fn ' + fn + '(')
    end = text.find('\n    async fn ', start + 1)
    if end == -1: end = text.index('\n}\n', start)
    body = text[start:end]
    pos = body.rindex('        Ok(())')
    body = body[:pos] + f'        slot_clock::controlled::mark({marker}, {expr});\n' + body[pos:]
    file.write_text(text[:start] + body + text[end:])

edit('common/slot_clock/Cargo.toml', '[dependencies]', '[dependencies]\ntokio = { workspace = true, features = ["time"] }')
edit('common/slot_clock/src/lib.rs', 'pub use crate::system_time_slot_clock::SystemTimeSlotClock;', 'pub use crate::system_time_slot_clock::SystemTimeSlotClock;\npub mod controlled;')
shutil.copyfile('bakes/shared/controlled_clock.rs', root / 'common/slot_clock/src/controlled.rs')
p = 'common/slot_clock/src/system_time_slot_clock.rs'
edit(p, 'use std::time::{Duration, SystemTime, UNIX_EPOCH};', 'use std::time::Duration;\n#[cfg(test)]\nuse std::time::{SystemTime, UNIX_EPOCH};')
edit(p, 'SystemTime::now().duration_since(UNIX_EPOCH).ok()', 'crate::controlled::now()', 6)
for p in ['beacon_node/timer/src/lib.rs', 'beacon_node/beacon_chain/src/proposer_prep_service.rs', 'validator_client/validator_services/src/preparation_service.rs', 'validator_client/validator_services/src/payload_attestation_service.rs', 'validator_client/validator_services/src/proposer_preferences_service.rs', 'validator_client/validator_services/src/builder_preferences_service.rs']:
    edit(p, 'use tokio::time::sleep;', 'use slot_clock::controlled::sleep;')
for p in ['validator_client/validator_services/src/attestation_service.rs', 'validator_client/validator_services/src/sync_committee_service.rs']:
    edit(p, 'use tokio::time::{Duration, Instant, sleep, sleep_until};', 'use tokio::time::{Duration, Instant};\nuse slot_clock::controlled::{sleep, sleep_until, instant_now};')
    file = root / p
    file.write_text(file.read_text().replace('Instant::now()', 'instant_now()'))
p = 'beacon_node/beacon_chain/src/state_advance_timer.rs'
edit(p, 'use tokio::time::{Instant, sleep, sleep_until};', 'use slot_clock::controlled::{sleep, sleep_until, instant_now};')
file = root / p
file.write_text(file.read_text().replace('Instant::now()', 'instant_now()'))
edit('validator_client/validator_services/src/duties_service.rs', 'use tokio::{sync::mpsc::Sender, time::sleep};', 'use tokio::sync::mpsc::Sender;\nuse slot_clock::controlled::sleep;')
p = root / 'validator_client/beacon_node_fallback/src/lib.rs'
p.write_text(p.read_text().replace('sleep(sleep_time).await', 'slot_clock::controlled::sleep(sleep_time).await'))
# The head-event race also contains a protocol attestation deadline.
edit('validator_client/beacon_node_fallback/src/beacon_head_monitor.rs', 'use tokio::time::sleep;', 'use slot_clock::controlled::sleep;')
# Deadline sleeps may legitimately be zero after a head event. They must finish immediately.
edit('validator_client/validator_services/src/attestation_service.rs', 'sleep(duration_to_deadline).await;', 'sleep_until(instant_now() + duration_to_deadline).await;')
edit('validator_client/validator_services/src/payload_attestation_service.rs', 'sleep(deadline).await;', 'slot_clock::controlled::sleep_until(slot_clock::controlled::instant_now() + deadline).await;')
edit('beacon_node/timer/src/lib.rs', 'beacon_chain.per_slot_task().await;', 'beacon_chain.per_slot_task().await;\n            if let Ok(slot) = beacon_chain.slot() { slot_clock::controlled::mark("slot", slot.as_u64()); }')
edit('beacon_node/beacon_chain/src/state_advance_timer.rs', '                    is_running.unlock();', '                    is_running.unlock();\n                    slot_clock::controlled::mark("state_advance", current_slot.as_u64());')
edit('beacon_node/beacon_chain/src/state_advance_timer.rs', '                        // Signal block proposal for the next slot', '                        slot_clock::controlled::mark("fork_choice", next_slot.as_u64() - 1);\n                        // Signal block proposal for the next slot')
edit('validator_client/src/lib.rs', '    let now = SystemTime::now()\n        .duration_since(UNIX_EPOCH)\n        .map_err(|e| format!("Unable to read system time: {:?}", e))?;', '    let now = slot_clock::controlled::now().ok_or("Unable to read protocol time")?;')
edit('validator_client/src/lib.rs', '        Ok(())\n    }\n}\n\nasync fn init_from_beacon_node', '        slot_clock::controlled::mark("ready", 0);\n        Ok(())\n    }\n}\n\nasync fn init_from_beacon_node')
edit('validator_client/validator_services/src/duties_service.rs', '                poll_validator_indices(&duties_service).await;', '                poll_validator_indices(&duties_service).await;\n                if let Some(slot) = duties_service.slot_clock.now() { slot_clock::controlled::mark("indices", slot.as_u64()); }')
# Marks are emitted after the signing streams and HTTP publication have completed.
finish('validator_client/validator_services/src/attestation_service.rs', 'sign_and_publish_attestations', '"attestations"', 'slot.as_u64()')
finish('validator_client/validator_services/src/attestation_service.rs', 'handle_aggregates', '&format!("aggregates_{}", committee_index)', 'slot.as_u64()')
finish('validator_client/validator_services/src/sync_committee_service.rs', 'publish_sync_committee_signatures', '"sync_messages"', 'slot.as_u64()')
finish('validator_client/validator_services/src/sync_committee_service.rs', 'publish_sync_committee_aggregate_for_subnet', '&format!("sync_aggregate_{}", subnet_id)', 'slot.as_u64()')
edit('validator_client/validator_services/src/sync_committee_service.rs', '        for (subnet_id, subnet_aggregators) in slot_duties.aggregators {', '        let mask = slot_duties.aggregators.keys().fold(0u64, |mask, subnet| { let index: u64 = (*subnet).into(); mask | (1 << index) });\n        slot_clock::controlled::mark("sync_expected_mask", mask);\n        slot_clock::controlled::mark("sync_expected_slot", slot.as_u64());\n        for (subnet_id, subnet_aggregators) in slot_duties.aggregators {')
finish('validator_client/validator_services/src/payload_attestation_service.rs', 'sign_and_publish', '"payload_attestations"', 'slot.as_u64()')
p = root / 'Cargo.lock'
s = p.read_text(); start = s.index('name = "slot_clock"'); end = s.index('[[package]]', start)
section = s[start:end].replace(' "types",', ' "tokio",\n "types",')
p.write_text(s[:start] + section + s[end:])

# PTC sampling keeps identical candidates, random bytes and acceptance thresholds.
shutil.copyfile('bakes/gloas/native/weighted_selection.rs', root / 'consensus/types/src/state/panda_weighted_selection.rs')
edit('consensus/types/src/state/mod.rs', 'mod beacon_state;', 'mod beacon_state;\nmod panda_weighted_selection;')
edit('consensus/types/src/state/beacon_state.rs',
     '        let mut selected = Vec::with_capacity(size);\n        let mut i = 0usize;',
     '''        if !shuffle_indices || indices.len() <= 4096 {
            let max = spec.max_effective_balance_for_fork(self.fork_name_unchecked());
            let ordered = super::panda_weighted_selection::order(indices, seed, spec.shuffle_round_count, shuffle_indices)
                .ok_or(BeaconStateError::UnableToShuffle)?;
            let candidates = ordered.iter().map(|&index| {
                let threshold = self.get_effective_balance(index)?.safe_mul(MAX_RANDOM_VALUE)?.safe_div(max)?;
                Ok((index, threshold))
            }).collect::<Result<Vec<_>, BeaconStateError>>()?;
            return super::panda_weighted_selection::select(&candidates, seed, size)
                .ok_or(BeaconStateError::InvalidIndicesCount);
        }
        let mut selected = Vec::with_capacity(size);
        let mut i = 0usize;''')
# Run the very same implementation as a small standalone integration target.
(root / 'consensus/types/tests').mkdir(exist_ok=True)
(root / 'consensus/types/tests/panda_weighted_selection.rs').write_text(
    '#[path = "../src/state/panda_weighted_selection.rs"]\nmod selection;\n')

shutil.copyfile('bakes/gloas/native/prepare_skip.rs', root / 'beacon_node/beacon_chain/src/panda_controlled_skip.rs')
edit('beacon_node/beacon_chain/src/lib.rs', 'mod beacon_chain;', 'mod beacon_chain;\nmod panda_controlled_skip;')
edit('beacon_node/timer/src/lib.rs', '            beacon_chain.per_slot_task().await;', '''            if let Err(error) = beacon_chain.prepare_controlled_skip().await {
                warn!(%error, "Controlled skip preparation failed");
                continue;
            }
            beacon_chain.per_slot_task().await;
            if let Ok(slot) = beacon_chain.slot() { slot_clock::controlled::mark("skip_ready", slot.as_u64()); }''')
edit('beacon_node/beacon_chain/src/beacon_chain.rs', '        let head_state = self.head_beacon_state_cloned();', '''        let head_state = if std::env::var_os("PANDA_CLOCK_START_MS").is_some() {
            let head = self.head_snapshot();
            self.store.get_advanced_hot_state_from_cache(head.beacon_block_root, slot)
                .map(|(_, state)| state).unwrap_or_else(|| head.beacon_state.clone())
        } else {
            self.head_beacon_state_cloned()
        };''')
edit('beacon_node/beacon_chain/src/shuffling_cache.rs',
     'if cached_head.head_block_root() == head_block_root {',
     '''if cached_head.head_block_root() == head_block_root
            && (std::env::var_os("PANDA_CLOCK_START_MS").is_none()
                || cached_head.snapshot.beacon_state.current_epoch() + 1 >= shuffling_epoch) {''')
edit('beacon_node/beacon_chain/src/beacon_chain.rs',
     'if self.best_slot() + MAX_PER_SLOT_FORK_CHOICE_DISTANCE < slot {',
     'if self.best_slot() + MAX_PER_SLOT_FORK_CHOICE_DISTANCE < slot && std::env::var_os("PANDA_CLOCK_START_MS").is_none() {')
# Duty endpoints otherwise clone the old head and repeat the entire skipped range.
edit('beacon_node/beacon_chain/src/beacon_proposer_cache.rs',
     '''        let head_state = head.snapshot.beacon_state.clone();
        let head_state_root = head.head_state_root();''',
     '''        let cached = if std::env::var_os("PANDA_CLOCK_START_MS").is_some() {
            chain.store.get_advanced_hot_state_from_cache(
                head.head_block_root(), request_epoch.end_slot(T::EthSpec::slots_per_epoch()))
        } else { None };
        let (head_state_root, head_state) = cached.unwrap_or_else(||
            (head.head_state_root(), head.snapshot.beacon_state.clone()));''')
for path in ['beacon_node/http_api/src/attester_duties.rs', 'beacon_node/http_api/src/ptc_duties.rs']:
    edit(path, '''            Some((
                head.beacon_state_root(),
                head.beacon_state.clone(),
                execution_status.is_optimistic_or_invalid(),
            ))''', '''            let cached = if std::env::var_os("PANDA_CLOCK_START_MS").is_some() {
                chain.store.get_advanced_hot_state_from_cache(
                    head.beacon_block_root, request_epoch.end_slot(T::EthSpec::slots_per_epoch()))
            } else { None };
            let (root, state) = cached.unwrap_or_else(||
                (head.beacon_state_root(), head.beacon_state.clone()));
            Some((root, state, execution_status.is_optimistic_or_invalid()))''')
edit('beacon_node/beacon_chain/src/beacon_chain.rs', '''                (
                    Cow::Borrowed(head_state),
                    cached_head.head_state_root(),
                    head_block.payload_bid_block_hash().ok(),
                )''', '''                let cached = if std::env::var_os("PANDA_CLOCK_START_MS").is_some() {
                    self.store.get_advanced_hot_state_from_cache(head_block_root, proposal_slot)
                } else { None };
                let (state, root) = cached.map(|(root, state)| (Cow::Owned(state), root))
                    .unwrap_or_else(|| (Cow::Borrowed(head_state), cached_head.head_state_root()));
                (state, root, head_block.payload_bid_block_hash().ok())''')

# Local sync delivery after the profile-specific scheduling adaptations.
patch_direct_sync(root, profile='gloas')

from patch_checkpoint import apply as patch_checkpoint
patch_checkpoint(root)
