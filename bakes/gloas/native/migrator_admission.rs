//! Keep queued database maintenance inside the native checkpoint barrier.
//!
//! Pinned-source producers are `canonical_head::after_finalization` (guarded slot/import work),
//! manual database HTTP operations (guarded TaskSpawner), and builder startup before API readiness.
//! Reconstruction requeues while its current batch still owns a guard. No wall-clock producer
//! creates these notifications. Historical-block backfill is a further upstream producer; Panda's
//! isolated genesis network has no external peers or backfill. Supporting peer sync would require
//! admission around that importer as well, before its database writes and subsequent enqueue.
use slot_clock::controlled::{self, WorkGuard};
use std::sync::mpsc;

pub struct Pending<T> {
    pub value: T,
    pub guard: WorkGuard,
}

pub struct Sender<T>(mpsc::Sender<Pending<T>>);

impl<T> Clone for Sender<T> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<T> Sender<T> {
    pub fn send(&self, value: T) -> Result<(), mpsc::SendError<T>> {
        // Runtime callers already own a protocol/API guard, or a previous migration batch.
        // Startup callers enqueue before API readiness. Waiting for admission here would
        // deadlock park against an admitted parent that needs to enqueue its continuation.
        // Keep this guard from before enqueue through processing, including reconstruction
        // requeues; the worker must retain guards for notifications it coalesces.
        let guard = controlled::background_work();
        self.0
            .send(Pending { value, guard })
            .map_err(|error| mpsc::SendError(error.0.value))
    }
}

pub fn channel<T>() -> (Sender<T>, mpsc::Receiver<Pending<T>>) {
    let (sender, receiver) = mpsc::channel();
    (Sender(sender), receiver)
}
