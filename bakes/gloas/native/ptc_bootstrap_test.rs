//! Test the production startup entry point, not a copy of its preload algorithm.
use super::*;
use validator_test_rig::mock_beacon_node::PandaBootstrapGate;
use validator_test_rig::validator_client_harness::ValidatorClientHarness;

const FROZEN_TIME: Duration = Duration::from_millis(47_500);

// The production clock is process-global. Each case owns one process and one clock endpoint.
fn child(name: &str) -> bool {
    if std::env::var("PANDA_BOOTSTRAP_CHILD").as_deref() == Ok(name) {
        assert_eq!(slot_clock::controlled::now(), Some(FROZEN_TIME));
        return false;
    }
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", name, "--nocapture"])
        .env("PANDA_BOOTSTRAP_CHILD", name)
        .env("PANDA_CLOCK_START_MS", "47500")
        .env("PANDA_CLOCK_PORT", port.to_string())
        .env_remove("PANDA_CLOCK_PARKED")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"));
    true
}

struct ReleaseGates(Vec<Arc<PandaBootstrapGate>>);
impl Drop for ReleaseGates {
    fn drop(&mut self) {
        for gate in &self.0 {
            gate.open();
        }
    }
}

async fn observed(gate: &PandaBootstrapGate) {
    tokio::time::timeout(Duration::from_secs(5), gate.wait_seen())
        .await
        .expect("production startup did not make the expected real HTTP request");
}

async fn run(case: &str) {
    let mut harness = ValidatorClientHarness::new(3).await;
    harness.slot_clock.advance_time(FROZEN_TIME);
    // Upstream's harness pre-resolves every index. Reinitialize its existing real keystores
    // through the normal validator API so two indices really require Beacon HTTP discovery.
    let validators = harness.validator_store.initialized_validators();
    {
        let mut validators = validators.write();
        for definition in validators.as_mut_slice_testing_only() {
            definition.enabled = false;
        }
        validators.update_validators().await.unwrap();
        for definition in validators.as_mut_slice_testing_only() {
            definition.enabled = true;
        }
        validators.update_validators().await.unwrap();
    }
    harness
        .validator_store
        .set_validator_index(&harness.pubkeys[0], 0);
    assert_eq!(
        harness.validator_store.validator_index(&harness.pubkeys[1]),
        None
    );
    assert_eq!(
        harness.validator_store.validator_index(&harness.pubkeys[2]),
        None
    );

    let successful = case == "ready";
    let indices = PandaBootstrapGate::new(!successful);
    // Before index discovery is observed, allow r5's independently spawned PTC polls through.
    // Otherwise a synchronous mock callback could block the server before the index request.
    let current = PandaBootstrapGate::new(true);
    let next = PandaBootstrapGate::new(true);
    let absent = PandaBootstrapGate::new(true);
    let mut mocks = Vec::new();
    for node in [
        &mut harness.mock_beacon_node_1,
        &mut harness.mock_beacon_node_2,
    ] {
        mocks.push(node.panda_bootstrap_index(
            harness.pubkeys[1],
            1,
            if case == "indices-error" { 503 } else { 200 },
            indices.clone(),
        ));
        // A local validator not yet present on chain is a valid 404, not a startup error.
        mocks.push(node.panda_bootstrap_index(harness.pubkeys[2], 2, 404, absent.clone()));
        for (epoch, gate, failure) in [
            (0, current.clone(), "current-error"),
            (1, next.clone(), "next-error"),
        ] {
            let duties = harness.pubkeys[..2]
                .iter()
                .enumerate()
                .map(|(index, &pubkey)| PtcDuty {
                    pubkey,
                    validator_index: index as u64,
                    slot: Slot::new(if epoch == 0 { 4 } else { 32 }),
                })
                .collect();
            mocks.push(node.panda_bootstrap_ptc(
                Epoch::new(epoch),
                duties,
                if case == failure { 503 } else { 200 },
                gate,
            ));
        }
    }
    // Release synchronous server callbacks on an assertion failure before dropping mock servers.
    let _release = ReleaseGates(vec![
        indices.clone(),
        current.clone(),
        next.clone(),
        absent.clone(),
    ]);
    let service = Arc::new(
        DutiesServiceBuilder::new()
            .validator_store(harness.validator_store.clone())
            .slot_clock(harness.slot_clock.clone())
            .beacon_nodes(harness.beacon_nodes.clone())
            .executor(harness.test_runtime.task_executor.clone())
            .spec(harness.spec.clone())
            .build()
            .unwrap(),
    );
    let (tx, _rx) = tokio::sync::mpsc::channel(32);
    let startup_service = service.clone();
    let startup = tokio::spawn(async move { start_update_service(startup_service, tx).await });

    if successful {
        observed(&indices).await;
        assert!(
            !startup.is_finished(),
            "startup returned before index discovery completed"
        );
        assert_eq!(service.ptc_count(Epoch::new(1)), 0);
        current.close();
        next.close();
        indices.open();
        observed(&current).await;
        assert!(
            !startup.is_finished(),
            "startup returned before current-epoch PTC preload completed"
        );
        current.open();
        observed(&next).await;
        assert!(
            !startup.is_finished(),
            "startup returned before next-epoch PTC preload completed"
        );
        assert_eq!(service.ptc_count(Epoch::new(0)), 2);
        next.open();
        tokio::time::timeout(Duration::from_secs(5), startup)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            harness.validator_store.validator_index(&harness.pubkeys[1]),
            Some(1)
        );
        assert_eq!(
            harness.validator_store.validator_index(&harness.pubkeys[2]),
            None
        );
        observed(&absent).await;
        assert_eq!(service.ptc_count(Epoch::new(0)), 2);
        assert_eq!(service.ptc_count(Epoch::new(1)), 2);
        assert_eq!(service.get_ptc_duties_for_slot(Slot::new(4)).len(), 2);
        assert_eq!(service.get_ptc_duties_for_slot(Slot::new(32)).len(), 2);
    } else {
        observed(match case {
            "indices-error" => &indices,
            "current-error" => &current,
            _ => &next,
        })
        .await;
        let result = tokio::time::timeout(Duration::from_secs(5), startup)
            .await
            .unwrap()
            .unwrap();
        assert!(
            result.is_err(),
            "{case}: startup reported ready despite failed HTTP preload"
        );
    }
    assert_eq!(slot_clock::controlled::now(), Some(FROZEN_TIME));
    assert_eq!(harness.slot_clock.now(), Some(Slot::new(3)));
    drop(mocks);
}

#[tokio::test]
async fn panda_bootstrap_waits_for_indices_and_both_ptc_epochs() {
    if child(
        "duties_service::panda_bootstrap::panda_bootstrap_waits_for_indices_and_both_ptc_epochs",
    ) {
        return;
    }
    run("ready").await;
}

#[tokio::test]
async fn panda_bootstrap_propagates_index_http_failure() {
    if child("duties_service::panda_bootstrap::panda_bootstrap_propagates_index_http_failure") {
        return;
    }
    run("indices-error").await;
}

#[tokio::test]
async fn panda_bootstrap_propagates_current_ptc_http_failure() {
    if child("duties_service::panda_bootstrap::panda_bootstrap_propagates_current_ptc_http_failure")
    {
        return;
    }
    run("current-error").await;
}

#[tokio::test]
async fn panda_bootstrap_propagates_next_ptc_http_failure() {
    if child("duties_service::panda_bootstrap::panda_bootstrap_propagates_next_ptc_http_failure") {
        return;
    }
    run("next-error").await;
}
