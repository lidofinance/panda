// Included in the production payload_attestation_service's existing tests module.
// Only clock interleaving is injected; duties, trigger selection, signing and HTTP are unchanged.
async fn panda_deadline_clock_race(retry: bool) {
    use crate::panda_ptc_deadline_context as clock;
    use std::sync::atomic::{AtomicBool, Ordering};
    let (tx, rx) = mpsc::channel(10);
    let mut harness =
        TestHarness::new_with_validators(1, if retry { Some(rx) } else { None }).await;
    let slot = Slot::new(4);
    harness.insert_ptc_duties(slot);
    let _get = harness
        .harness
        .mock_beacon_node_1
        .mock_get_validator_payload_attestation_data(
            &attestation_data(slot),
            ForkName::Gloas,
            slot,
        );
    let post = harness
        .harness
        .mock_beacon_node_1
        .mock_post_beacon_pool_payload_attestations_ssz(Duration::ZERO);
    clock::advance(
        &harness.service.slot_clock,
        Duration::from_millis(if retry { 48_000 } else { 47_500 }),
    )
    .await;
    let manual = harness.service.slot_clock.clone();
    let fired = Arc::new(AtomicBool::new(false));
    let observed = fired.clone();
    let hook: Box<dyn FnOnce() + Send> = Box::new(move || {
        // The remaining duration was computed before this hook. Time advances before sleep
        // consumes it: rebasing that duration on a fresh clock read would shift the deadline.
        manual.advance_time(Duration::from_millis(if retry { 3_000 } else { 500 }));
        clock::request(
            "POST",
            if retry {
                "/advance/51000"
            } else {
                "/advance/48000"
            },
        );
        observed.store(true, Ordering::Release);
    });
    if retry {
        *PANDA_PTC_DEADLINE_BEFORE_RETRY_SLEEP.lock().unwrap() = Some(hook);
        // Exercise the real early-error fallback without replacing the data-producing method.
        tx.send(PayloadAvailableEvent {
            beacon_node_index: 99,
            slot,
            block_root: Hash256::ZERO,
        })
        .await
        .unwrap();
    } else {
        *PANDA_PTC_DEADLINE_BEFORE_SLOT_SLEEP.lock().unwrap() = Some(hook);
    }
    harness.service.clone().start_update_service().unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !fired.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("production sleep interleaving was not reached");
    assert!(
        harness
            .harness
            .mock_beacon_node_1
            .payload_attestation_message
            .lock()
            .unwrap()
            .is_empty()
    );
    clock::advance(
        &harness.service.slot_clock,
        Duration::from_secs(if retry { 6 } else { 9 }),
    )
    .await;
    assert_eq!(slot_clock::controlled::now(), Some(Duration::from_secs(57)));
    tokio::time::timeout(Duration::from_secs(5), async {
        while !clock::request("GET", "/").contains("\"payload_attestations\":4") {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("PTC deadline shifted past slot4+9000ms after concurrent protocol advance");
    assert_eq!(
        harness
            .harness
            .mock_beacon_node_1
            .payload_attestation_message
            .lock()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(slot_clock::controlled::now(), Some(Duration::from_secs(57)));
    post.expect(1).assert();
}

#[tokio::test]
async fn panda_ptc_slot_deadline_survives_concurrent_clock_advance() {
    if crate::panda_ptc_deadline_context::child(
        "payload_attestation_service::tests::panda_ptc_slot_deadline_survives_concurrent_clock_advance",
    ) {
        return;
    }
    panda_deadline_clock_race(false).await;
}

#[tokio::test]
async fn panda_ptc_retry_deadline_survives_concurrent_clock_advance() {
    if crate::panda_ptc_deadline_context::child(
        "payload_attestation_service::tests::panda_ptc_retry_deadline_survives_concurrent_clock_advance",
    ) {
        return;
    }
    panda_deadline_clock_race(true).await;
}
