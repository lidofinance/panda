//! Native API cancellation must not release checkpoint admission before detached work finishes.
#[path = "../src/task_spawner.rs"]
mod task_spawner;
#[path = "../../../validator_client/http_api/src/panda_admission.rs"]
mod vc_admission;

use slot_clock::controlled;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;
use task_spawner::{Priority, TaskSpawner};
use types::{EthSpec, ForkName, MainnetEthSpec};

fn clock_request(port: u16, path: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    write!(
        stream,
        "POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n"
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
}

async fn resume(port: u16) {
    assert!(
        tokio::task::spawn_blocking(move || clock_request(port, "/resume"))
            .await
            .unwrap()
            .contains("200 OK")
    );
}

// Exercise the production router, not a copy of its filters. Checkpoint-specific rejection
// recovery must not turn another endpoint's path mismatch into a successful 404 response.
async fn checkpoint_routes_survive_park_and_resume(port: u16) {
    use beacon_chain::test_utils::BeaconChainHarness;
    use slot_clock::SlotClock;

    let spec = ForkName::Gloas.make_genesis_spec(MainnetEthSpec::default_spec());
    let harness = BeaconChainHarness::builder(MainnetEthSpec)
        .spec(spec.into())
        .deterministic_keypairs(64)
        .fresh_ephemeral_store()
        .build();
    let chain = &harness.chain;
    chain.slot_clock.set_current_time(
        *chain.slot_clock.genesis_duration() + Duration::from_millis(11_500),
    );
    let api = http_api::test_utils::create_api_server(chain.clone(), &harness.runtime).await;
    let base = format!("http://{}", api.listening_socket);
    let server = tokio::spawn(api.server);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();

    // The entire production router is constructed while the client is initially parked.
    assert!(controlled::is_parked());
    let genesis = client.get(format!("{base}/eth/v1/beacon/genesis")).send().await.unwrap();
    assert_eq!(genesis.status(), 200);
    let checkpoint = client.post(format!("{base}/lighthouse/panda/checkpoint")).send().await.unwrap();
    let status = checkpoint.status();
    let saved = checkpoint.text().await.unwrap();
    assert_eq!(status, 200, "checkpoint POST: {saved}");
    let receipt = client.get(format!("{base}/lighthouse/panda/checkpoint")).send().await.unwrap();
    assert_eq!(receipt.status(), 200);
    assert_eq!(receipt.text().await.unwrap(), saved);

    for _ in 0..2 {
        resume(port).await;
        for duty in ["attester", "sync", "ptc"] {
            let response = client.post(format!("{base}/eth/v1/validator/duties/{duty}/0"))
                .json(&["0"]).send().await.unwrap();
            let status = response.status();
            let body = response.text().await.unwrap();
            assert_eq!(status, 200, "normal {duty} POST after resume: {body}");
        }
        // Satisfy the upstream SSZ content-type filter so its header rejection cannot mask
        // the unknown path (an absent/mismatched Content-Type legitimately yields 400).
        let missing = client.post(format!("{base}/lighthouse/panda/unknown-route"))
            .header("Content-Type", "application/octet-stream").send().await.unwrap();
        let status = missing.status();
        let body = missing.text().await.unwrap();
        assert_eq!(status, 404, "unknown POST: {body}");
        assert!(tokio::task::spawn_blocking(move || clock_request(port, "/park"))
            .await.unwrap().contains("200 OK"));
        let blocked = client.post(format!("{base}/eth/v1/validator/duties/attester/0"))
            .json(&["0"]).send().await.unwrap();
        let status = blocked.status();
        let body = blocked.text().await.unwrap();
        assert_eq!(status, 400, "parked ordinary POST: {body}");
        assert!(body.contains("parked"), "unexpected parked response: {body}");
    }
    resume(port).await;
    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn cancelled_api_receiver_keeps_detached_work_in_checkpoint_barrier() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    unsafe {
        let genesis = beacon_chain::test_utils::HARNESS_GENESIS_TIME * 1_000;
        std::env::set_var("PANDA_CLOCK_START_MS", (genesis + 11_500).to_string());
        std::env::set_var("PANDA_CLOCK_PORT", port.to_string());
        std::env::set_var("PANDA_CLOCK_PARKED", "1");
    }
    controlled::now().unwrap();
    let original_time = controlled::now();
    checkpoint_routes_survive_park_and_resume(port).await;

    let spawner = TaskSpawner::<MainnetEthSpec>::new(None)
        .panda_write()
        .unwrap();
    let (entered, started) = tokio::sync::oneshot::channel();
    let (finish, until_finish) = std::sync::mpsc::channel();
    let until_finish = std::sync::Mutex::new(until_finish);
    let request = tokio::spawn(async move {
        spawner
            .blocking_task(Priority::P0, move || {
                entered.send(()).unwrap();
                until_finish.lock().unwrap().recv().unwrap();
                Ok(())
            })
            .await
    });
    started.await.unwrap();
    request.abort();
    let _ = request.await;
    let parking = tokio::task::spawn_blocking(move || clock_request(port, "/park"));
    tokio::time::sleep(Duration::from_millis(30)).await;
    let acknowledged_early = parking.is_finished();
    finish.send(()).unwrap();
    assert!(parking.await.unwrap().contains("200 OK"));
    assert!(
        !acknowledged_early,
        "cancelled HTTP receiver released detached blocking work"
    );
    resume(port).await;

    let spawner = TaskSpawner::<MainnetEthSpec>::new(None)
        .panda_write()
        .unwrap();
    let (entered, started) = tokio::sync::oneshot::channel();
    let (finish, until_finish) = tokio::sync::oneshot::channel();
    let request = tokio::spawn(async move {
        spawner
            .spawn_async_with_rejection_no_conversion(Priority::P0, async move {
                entered.send(()).unwrap();
                until_finish.await.unwrap();
                Ok(warp::reply::Response::new(Default::default()))
            })
            .await
    });
    started.await.unwrap();
    request.abort();
    let _ = request.await;
    let parking = tokio::task::spawn_blocking(move || clock_request(port, "/park"));
    tokio::time::sleep(Duration::from_millis(30)).await;
    let acknowledged_early = parking.is_finished();
    finish.send(()).unwrap();
    assert!(parking.await.unwrap().contains("200 OK"));
    assert!(
        !acknowledged_early,
        "cancelled HTTP receiver released detached async work"
    );
    resume(port).await;

    // Exercise the real BeaconProcessor channel path too: abort the HTTP receiver while the
    // admitted closure/future is still queued, then execute the exact queued work item.
    for asynchronous in [false, true] {
        let (send, mut receive) = tokio::sync::mpsc::channel(1);
        let spawner =
            TaskSpawner::<MainnetEthSpec>::new(Some(beacon_processor::BeaconProcessorSend(send)))
                .panda_write()
                .unwrap();
        let request = tokio::spawn(async move {
            if asynchronous {
                spawner
                    .spawn_async_with_rejection_no_conversion(Priority::P0, async {
                        Ok(warp::reply::Response::new(Default::default()))
                    })
                    .await
                    .map(|_| ())
            } else {
                spawner.blocking_task(Priority::P0, || Ok(())).await
            }
        });
        let event = receive.recv().await.unwrap();
        request.abort();
        let _ = request.await;
        let parking = tokio::task::spawn_blocking(move || clock_request(port, "/park"));
        tokio::time::sleep(Duration::from_millis(30)).await;
        let acknowledged_early = parking.is_finished();
        match event.work {
            beacon_processor::Work::ApiRequestP0(beacon_processor::BlockingOrAsync::Blocking(
                work,
            )) => work(),
            beacon_processor::Work::ApiRequestP0(beacon_processor::BlockingOrAsync::Async(
                work,
            )) => work.await,
            _ => panic!("unexpected API queue work"),
        }
        assert!(parking.await.unwrap().contains("200 OK"));
        assert!(
            !acknowledged_early,
            "cancelled receiver released queued API work"
        );
        resume(port).await;
    }

    // Unknown block/envelope reprocessing owns the same admitted work while still queued.
    let spawner = TaskSpawner::<MainnetEthSpec>::new(None)
        .panda_write()
        .unwrap();
    let queued = spawner.panda_reprocess(|| 42);
    drop(spawner);
    let parking = tokio::task::spawn_blocking(move || clock_request(port, "/park"));
    tokio::time::sleep(Duration::from_millis(30)).await;
    let acknowledged_early = parking.is_finished();
    assert_eq!(queued(), 42);
    assert!(parking.await.unwrap().contains("200 OK"));
    assert!(
        !acknowledged_early,
        "cancelled request released queued attestation reprocessing"
    );
    resume(port).await;

    // The VC keymanager has its own blocking task wrapper. Cancelling an import/delete response
    // must not release its filesystem and slashing-DB mutation from the checkpoint barrier.
    let (entered, started) = tokio::sync::oneshot::channel();
    let (finish, until_finish) = std::sync::mpsc::channel();
    let request = tokio::spawn(vc_admission::blocking_response_task(move || {
        entered.send(()).unwrap();
        until_finish.recv().unwrap();
        Ok(warp::reply())
    }));
    started.await.unwrap();
    request.abort();
    let _ = request.await;
    let parking = tokio::task::spawn_blocking(move || clock_request(port, "/park"));
    tokio::time::sleep(Duration::from_millis(30)).await;
    let acknowledged_early = parking.is_finished();
    finish.send(()).unwrap();
    assert!(parking.await.unwrap().contains("200 OK"));
    assert!(
        !acknowledged_early,
        "cancelled VC receiver released blocking keymanager mutation"
    );
    assert!(
        vc_admission::blocking_response_task(|| Ok(warp::reply()))
            .await
            .is_err()
    );
    assert!(
        TaskSpawner::<MainnetEthSpec>::new(None)
            .panda_write()
            .is_err()
    );
    assert!(
        TaskSpawner::<MainnetEthSpec>::new(None)
            .panda_request("GET", "/eth/v3/validator/blocks/1")
            .is_err()
    );
    assert!(
        TaskSpawner::<MainnetEthSpec>::new(None)
            .panda_request("POST", "/eth/v1/beacon/pool/attestations")
            .is_err()
    );
    assert!(
        TaskSpawner::<MainnetEthSpec>::new(None)
            .panda_request("GET", "/eth/v1/beacon/genesis")
            .is_ok()
    );
    assert!(
        TaskSpawner::<MainnetEthSpec>::new(None)
            .panda_request("GET", "/lighthouse/panda/checkpoint")
            .is_ok()
    );
    assert_eq!(controlled::now(), original_time);
    assert!(controlled::is_quiescent());
}
