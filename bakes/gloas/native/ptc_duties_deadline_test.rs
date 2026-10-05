// Exercise the actual duties-service task and HTTP cache population. The one-shot
// hook selects an interleaving after the wait duration is read, before sleep polls.
mod panda_duties_clock {
    use slot_clock::ManualSlotClock;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::time::Duration;

    pub fn child(case: &str) -> bool {
        let name = format!("duties_service::test::{case}");
        if std::env::var("PANDA_PTC_DUTIES_CHILD").as_deref() == Ok(name.as_str()) {
            assert_eq!(slot_clock::controlled::now(), Some(Duration::ZERO));
            return false;
        }
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &name, "--nocapture"])
            .env("PANDA_PTC_DUTIES_CHILD", &name)
            .env("PANDA_CLOCK_START_MS", "0")
            .env("PANDA_CLOCK_PORT", port.to_string())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while child.try_wait().unwrap().is_none() {
            if std::time::Instant::now() >= deadline {
                child.kill().unwrap();
                let output = child.wait_with_output().unwrap();
                panic!("native test child exceeded real 30s deadline: {}\n{}",
                    String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "{}\n{}",
            String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"));
        true
    }

    pub fn advance(clock: &ManualSlotClock, milliseconds: u64) {
        let duration = Duration::from_millis(milliseconds);
        clock.advance_time(duration);
        let now = slot_clock::controlled::now().unwrap() + duration;
        let port: u16 = std::env::var("PANDA_CLOCK_PORT").unwrap().parse().unwrap();
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        stream.set_write_timeout(Some(Duration::from_secs(5))).unwrap();
        write!(stream, "POST /advance/{} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n", now.as_millis()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    }
}

async fn panda_ptc_duties_after_delayed_sleep(empty_indices: bool) {
    use std::sync::atomic::AtomicUsize;
    use validator_test_rig::validator_client_harness::ValidatorClientHarness;
    let mut harness = ValidatorClientHarness::new(1).await;
    if empty_indices {
        // Reinitialize the existing real keystore to reproduce production's unknown index.
        let validators = harness.validator_store.initialized_validators();
        let mut validators = validators.write();
        for definition in validators.as_mut_slice_testing_only() { definition.enabled = false; }
        validators.update_validators().await.unwrap();
        for definition in validators.as_mut_slice_testing_only() { definition.enabled = true; }
        validators.update_validators().await.unwrap();
        drop(validators);
        assert_eq!(harness.validator_store.validator_index(&harness.pubkeys[0]), None);
    }
    let requests = (0..3).map(|_| Arc::new(AtomicUsize::new(0))).collect::<Vec<_>>();
    let mut mocks = Vec::new();
    for node in [&mut harness.mock_beacon_node_1, &mut harness.mock_beacon_node_2] {
        for epoch in 0..3 {
            mocks.push(node.panda_ptc_duties(Epoch::new(epoch), PtcDuty {
                pubkey: harness.pubkeys[0], validator_index: 0, slot: Slot::new(epoch * 32 + 4),
            }, requests[epoch as usize].clone()));
        }
    }
    let service = Arc::new(DutiesServiceBuilder::new()
        .validator_store(harness.validator_store.clone())
        .slot_clock(harness.slot_clock.clone())
        .beacon_nodes(harness.beacon_nodes.clone())
        .executor(harness.test_runtime.task_executor.clone())
        .spec(harness.spec.clone()).build().unwrap());
    let initial_ms = if empty_indices { 47_500 } else { 383_500 };
    panda_duties_clock::advance(&harness.slot_clock, initial_ms);
    let observed = Arc::new(AtomicBool::new(false));
    let fired = observed.clone();
    let hook_service = service.clone();
    let hook_requests = requests.clone();
    let pubkey = harness.pubkeys[0];
    *PANDA_PTC_DUTIES_BEFORE_SLEEP.lock().unwrap() = Some(Box::new(move || {
        let expected = if empty_indices { 0 } else { 1 };
        assert_eq!(hook_service.ptc_count(Epoch::new(0)), expected);
        assert_eq!(hook_service.ptc_count(Epoch::new(1)), expected);
        assert_eq!(hook_requests[0].load(Ordering::Acquire), expected);
        assert_eq!(hook_requests[1].load(Ordering::Acquire), expected);
        assert_eq!(hook_requests[2].load(Ordering::Acquire), 0);
        if empty_indices {
            // Model the independent index-discovery worker finishing after the empty PTC poll.
            assert_eq!(hook_service.validator_store.validator_index(&pubkey), None);
            hook_service.validator_store.set_validator_index(&pubkey, 0);
        }
        // The old 500ms relative wait is first polled at the next slot's phase 6.
        panda_duties_clock::advance(&hook_service.slot_clock, 6_500);
        fired.store(true, Ordering::Release);
    }));
    let (tx, _rx) = tokio::sync::mpsc::channel(32);
    start_update_service(service.clone(), tx);
    tokio::time::timeout(Duration::from_secs(5), async {
        while !observed.load(Ordering::Acquire) { tokio::task::yield_now().await; }
    }).await.expect("production PTC duties wait was not reached");
    let epoch = if empty_indices { 0 } else { 1 };
    tokio::time::timeout(Duration::from_secs(5), async {
        while service.ptc_count(Epoch::new(epoch)) != 1 || service.ptc_count(Epoch::new(epoch + 1)) != 1 {
            tokio::task::yield_now().await;
        }
    }).await.expect("PTC duties did not refresh while protocol time was frozen at phase 6");
    assert!(requests[epoch as usize].load(Ordering::Acquire) > 0);
    assert!(requests[epoch as usize + 1].load(Ordering::Acquire) > 0);
    assert_eq!(slot_clock::controlled::now(), Some(Duration::from_millis(initial_ms + 6_500)));
}

#[tokio::test]
async fn panda_ptc_duties_empty_indices_delayed_sleep() {
    if panda_duties_clock::child("panda_ptc_duties_empty_indices_delayed_sleep") { return; }
    panda_ptc_duties_after_delayed_sleep(true).await;
}

#[tokio::test]
async fn panda_ptc_duties_epoch_refresh_delayed_sleep() {
    if panda_duties_clock::child("panda_ptc_duties_epoch_refresh_delayed_sleep") { return; }
    panda_ptc_duties_after_delayed_sleep(false).await;
}
