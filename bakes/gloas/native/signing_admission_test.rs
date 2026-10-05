use bls::Keypair;
use eth2_keystore::KeystoreBuilder;
use parking_lot::Mutex;
use signing_method::{SignableMessage, SigningMethod};
use slot_clock::controlled;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Condvar};
use std::time::Duration;
use task_executor::{RayonPoolType, test_utils::TestRuntime};
use types::{FullPayload, Hash256, MainnetEthSpec, Slot};

fn clock_request(port: u16, path: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
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

#[tokio::test]
async fn cancelled_signing_receiver_keeps_rayon_work_in_checkpoint_barrier() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    unsafe {
        std::env::set_var("PANDA_CLOCK_START_MS", "2000000000000");
        std::env::set_var("PANDA_CLOCK_PORT", port.to_string());
    }
    let original_time = controlled::now();
    let runtime = TestRuntime::default();
    let keypair = Arc::new(Keypair::random());
    let method = SigningMethod::LocalKeystore {
        voting_keystore_path: Default::default(),
        voting_keystore_lockfile: Mutex::new(None),
        voting_keystore: KeystoreBuilder::new(&keypair, b"test", String::new())
            .unwrap()
            .build()
            .unwrap(),
        voting_keypair: keypair.clone(),
    };
    // Occupy the actual high-priority pool so cancellation deterministically occurs while
    // the real signature is queued, instead of racing a sub-millisecond BLS operation.
    let workers = (num_cpus::get() * 80 / 100).max(1);
    let barrier = Arc::new((std::sync::Mutex::new(false), Condvar::new()));
    let (entered, mut started) = tokio::sync::mpsc::unbounded_channel();
    let mut blockers = Vec::new();
    for _ in 0..workers {
        let executor = runtime.task_executor.clone();
        let barrier = barrier.clone();
        let entered = entered.clone();
        blockers.push(tokio::spawn(async move {
            executor
                .spawn_blocking_with_rayon_async(RayonPoolType::HighPriority, move || {
                    entered.send(()).unwrap();
                    let (lock, ready) = &*barrier;
                    let mut finished = lock.lock().unwrap();
                    while !*finished {
                        finished = ready.wait(finished).unwrap();
                    }
                })
                .await
                .unwrap();
        }));
    }
    for _ in 0..workers {
        tokio::time::timeout(Duration::from_secs(2), started.recv())
            .await
            .unwrap()
            .unwrap();
    }
    let root = Hash256::repeat_byte(42);
    let mut signing = Box::pin(
        method.get_signature_from_root::<MainnetEthSpec, FullPayload<MainnetEthSpec>>(
            SignableMessage::SelectionProof(Slot::new(1)),
            root,
            &runtime.task_executor,
            None,
        ),
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(20), &mut signing)
            .await
            .is_err()
    );
    drop(signing);
    let parking = tokio::task::spawn_blocking(move || clock_request(port, "/park"));
    tokio::time::sleep(Duration::from_millis(30)).await;
    let acknowledged_early = parking.is_finished();
    {
        let (lock, ready) = &*barrier;
        *lock.lock().unwrap() = true;
        ready.notify_all();
    }
    for blocker in blockers {
        blocker.await.unwrap();
    }
    assert!(parking.await.unwrap().contains("200 OK"));
    assert!(
        !acknowledged_early,
        "cancelled receiver released queued Rayon signing work"
    );
    assert!(controlled::is_quiescent());
    assert!(
        tokio::task::spawn_blocking(move || clock_request(port, "/resume"))
            .await
            .unwrap()
            .contains("200 OK")
    );
    let signature = method
        .get_signature_from_root::<MainnetEthSpec, FullPayload<MainnetEthSpec>>(
            SignableMessage::SelectionProof(Slot::new(1)),
            root,
            &runtime.task_executor,
            None,
        )
        .await
        .unwrap();
    assert!(
        signature.verify(&keypair.pk, root),
        "real BLS signing changed"
    );
    assert_eq!(controlled::now(), original_time);
}
