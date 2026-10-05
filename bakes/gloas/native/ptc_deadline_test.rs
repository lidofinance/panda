// Included in the production payload-attestation test module. The hooks only select
// scheduler interleavings; slot selection, signing, HTTP and the clock are unchanged.
mod panda_clock {
    use slot_clock::ManualSlotClock;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::time::Duration;

    pub fn child(case: &str) -> bool {
        let name = format!("payload_attestation_service::tests::{case}");
        if std::env::var("PANDA_PTC_DEADLINE_CHILD").as_deref() == Ok(name.as_str()) {
            assert_eq!(slot_clock::controlled::now(), Some(Duration::ZERO));
            return false;
        }
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &name, "--nocapture"])
            .env("PANDA_PTC_DEADLINE_CHILD", &name)
            .env("PANDA_CLOCK_START_MS", "0")
            .env("PANDA_CLOCK_PORT", port.to_string())
            .output()
            .unwrap();
        assert!(output.status.success(), "{}\n{}",
            String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"));
        true
    }

    pub fn request(method: &str, path: &str) -> String {
        let port: u16 = std::env::var("PANDA_CLOCK_PORT").unwrap().parse().unwrap();
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        stream.set_write_timeout(Some(Duration::from_secs(5))).unwrap();
        write!(stream,
            "{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n").unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    pub fn advance(clock: &ManualSlotClock, milliseconds: u64) {
        let duration = Duration::from_millis(milliseconds);
        clock.advance_time(duration);
        let now = slot_clock::controlled::now().unwrap() + duration;
        let response = request("POST", &format!("/advance/{}", now.as_millis()));
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    }

    pub fn wait(slot: u64, expected: u16) {
        let response = request("POST", &format!("/wait/{slot}/30/ptc_wait"));
        assert!(response.starts_with(&format!("HTTP/1.1 {expected}")), "{response}");
    }
}

#[tokio::test]
async fn panda_ptc_deadline_survives_clock_advance() {
    if panda_clock::child("panda_ptc_deadline_survives_clock_advance") { return; }
    use std::sync::atomic::{AtomicBool, Ordering};
    let mut harness = TestHarness::new_with_validators(1, None).await;
    let slot = Slot::new(4);
    harness.insert_ptc_duties(slot);
    let _get = harness.harness.mock_beacon_node_1
        .mock_get_validator_payload_attestation_data(&attestation_data(slot), ForkName::Gloas, slot);
    let post = harness.harness.mock_beacon_node_1
        .mock_post_beacon_pool_payload_attestations_ssz(Duration::ZERO);
    panda_clock::advance(&harness.service.slot_clock, 47_500);
    let manual = harness.service.slot_clock.clone();
    let fired = Arc::new(AtomicBool::new(false));
    let observed = fired.clone();
    *PANDA_PTC_BEFORE_SLEEP.lock().unwrap() = Some(Box::new(move || {
        // Compute the remaining delay at slot 3's tail, but register the sleep in slot 4.
        panda_clock::advance(&manual, 500);
        observed.store(true, Ordering::Release);
    }));
    harness.service.clone().start_update_service().unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !fired.load(Ordering::Acquire) { tokio::task::yield_now().await; }
    }).await.expect("production sleep interleaving was not reached");
    assert!(harness.harness.mock_beacon_node_1.payload_attestation_message.lock().unwrap().is_empty());
    panda_clock::advance(&harness.service.slot_clock, 9_000);
    tokio::time::timeout(Duration::from_secs(5), async {
        while !panda_clock::request("GET", "/").contains("\"payload_attestations\":4") {
            tokio::task::yield_now().await;
        }
    }).await.expect("PTC deadline shifted past slot 4 + 9000ms");
    assert_eq!(harness.harness.mock_beacon_node_1.payload_attestation_message.lock().unwrap().len(), 1);
    assert_eq!(slot_clock::controlled::now(), Some(Duration::from_secs(57)));
    post.expect(1).assert();
}

#[tokio::test]
async fn panda_ptc_wait_covers_delayed_first_poll_and_loop_reentry() {
    if panda_clock::child("panda_ptc_wait_covers_delayed_first_poll_and_loop_reentry") { return; }
    let harness = TestHarness::new_with_validators(1, None).await;
    panda_clock::advance(&harness.service.slot_clock, 47_500);

    // Creating the production future does not select a target. Panda's existing wait API
    // must keep the boundary closed until the task actually gets its first poll.
    let first = harness.service.wait_for_attestation_slot();
    tokio::pin!(first);
    panda_clock::wait(4, 408);
    assert_eq!(slot_clock::controlled::now(), Some(Duration::from_millis(47_500)));
    assert!(first.as_mut().now_or_never().is_none());
    panda_clock::wait(4, 200);
    panda_clock::advance(&harness.service.slot_clock, 500);
    assert!(first.as_mut().now_or_never().is_none());
    panda_clock::advance(&harness.service.slot_clock, 9_000);
    assert_eq!(first.await, Some(Slot::new(4)));

    // The old mark cannot authorize the next boundary while the service has not yet
    // re-entered its wait. Exercise that same production method a second time.
    let next = harness.service.wait_for_attestation_slot();
    tokio::pin!(next);
    panda_clock::wait(5, 408);
    assert_eq!(slot_clock::controlled::now(), Some(Duration::from_secs(57)));
    assert!(next.as_mut().now_or_never().is_none());
    panda_clock::wait(5, 200);
    panda_clock::wait(4, 409);
    panda_clock::advance(&harness.service.slot_clock, 3_000);
    assert!(next.as_mut().now_or_never().is_none());
    panda_clock::advance(&harness.service.slot_clock, 9_000);
    assert_eq!(next.await, Some(Slot::new(5)));
}

#[tokio::test]
async fn panda_ptc_wait_allows_advance_before_sleep_poll() {
    if panda_clock::child("panda_ptc_wait_allows_advance_before_sleep_poll") { return; }
    let harness = TestHarness::new_with_validators(1, None).await;
    panda_clock::advance(&harness.service.slot_clock, 47_500);
    let manual = harness.service.slot_clock.clone();
    *PANDA_PTC_BEFORE_SLEEP.lock().unwrap() = Some(Box::new(move || {
        // Panda observes the selected target before the sleep future is polled, then
        // reaches its deadline. An absolute wait must see that advance immediately.
        panda_clock::wait(4, 200);
        panda_clock::advance(&manual, 9_500);
    }));
    let slot = tokio::time::timeout(Duration::from_secs(1), harness.service.wait_for_attestation_slot())
        .await.expect("advance between target mark and first sleep poll was lost");
    assert_eq!(slot, Some(Slot::new(4)));
    assert_eq!(slot_clock::controlled::now(), Some(Duration::from_secs(57)));
}
