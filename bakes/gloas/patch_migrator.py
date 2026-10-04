"""Drain native database maintenance before acknowledging a Panda checkpoint."""
from pathlib import Path
import shutil


def apply(root):
    root = Path(root)
    here = Path(__file__).resolve().parent

    def edit(path, old, new, count=1):
        file = root / path
        text = file.read_text()
        if text.count(old) != count:
            raise RuntimeError(f'{path}: migrator patch expected {count} occurrences of {old!r}')
        file.write_text(text.replace(old, new))

    shutil.copyfile(here / 'native/migrator_admission.rs',
                    root / 'beacon_node/beacon_chain/src/panda_migrator_admission.rs')
    edit('beacon_node/beacon_chain/src/lib.rs', 'mod migrate;',
         'mod migrate;\nmod panda_migrator_admission;')
    path = 'beacon_node/beacon_chain/src/migrate.rs'
    edit(path, 'use std::sync::{Arc, mpsc};',
         'use std::sync::Arc;\nuse crate::panda_migrator_admission::{self as admission, Pending, Sender};')
    edit(path, 'mpsc::Sender<Notification>', 'Sender<Notification>', 3)
    edit(path, '        let (tx, rx) = mpsc::channel();',
         '        let (tx, rx) = admission::channel();')
    edit(path, '            while let Ok(notif) = rx.recv() {',
         '''            while let Ok(Pending { value: notif, guard }) = rx.recv() {
                // Coalescing discards redundant notifications, not their admitted lifetime.
                // Retain every guard until all selected work and reconstruction requeues finish.
                let mut panda_work = vec![guard];''')
    edit(path, '                for notif in rx.try_iter() {',
         '''                for Pending { value: notif, guard } in rx.try_iter() {
                    panda_work.push(guard);''')
    # A failed retry must not silently erase accepted maintenance. The existing foreground
    # branches process the returned notification under their own continuation guard.
    edit(path, '                let _ = tx.send(tx_err.0);',
         '''                if let Err(error) = tx.send(tx_err.0) {
                    return Some(error.0);
                }''')
    edit(path, '''    ) -> Result<(), BeaconChainError> {
        let notif = FinalizationNotification {''',
         '''    ) -> Result<(), BeaconChainError> {
        let _panda_work = slot_clock::controlled::background_work();
        let notif = FinalizationNotification {''')
    for signature in [
        '    pub fn process_manual_compaction(&self) {',
        '    pub fn process_manual_finalization(&self, notif: ManualFinalizationNotification) {',
        '    pub fn process_reconstruction(&self) {',
        '    pub fn process_prune_blobs(&self, data_availability_boundary: Epoch) {',
    ]:
        edit(path, signature,
             signature + '\n        let _panda_work = slot_clock::controlled::background_work();')
    shutil.copyfile(here / 'native/migrator_admission_test.rs',
                    root / 'beacon_node/beacon_chain/tests/panda_migrator_admission.rs')
    with (root / 'beacon_node/beacon_chain/Cargo.toml').open('a') as target:
        target.write('\n[[test]]\nname = "panda_migrator_admission"\npath = "tests/panda_migrator_admission.rs"\n')
