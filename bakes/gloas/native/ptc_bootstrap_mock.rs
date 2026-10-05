// Test-only HTTP fixtures appended to validator_test_rig::mock_beacon_node.
// Responses are complete for the requested indices; no request/response truncation.
pub struct PandaBootstrapGate {
    seen: std::sync::atomic::AtomicBool,
    seen_waker: futures::task::AtomicWaker,
    released: Mutex<bool>,
    release: std::sync::Condvar,
}

impl PandaBootstrapGate {
    pub fn new(open: bool) -> Arc<Self> {
        Arc::new(Self {
            seen: std::sync::atomic::AtomicBool::new(false),
            seen_waker: futures::task::AtomicWaker::new(),
            released: Mutex::new(open),
            release: std::sync::Condvar::new(),
        })
    }

    pub async fn wait_seen(&self) {
        futures::future::poll_fn(|cx| {
            self.seen_waker.register(cx.waker());
            if self.seen.load(std::sync::atomic::Ordering::Acquire) {
                std::task::Poll::Ready(())
            } else {
                std::task::Poll::Pending
            }
        })
        .await;
    }

    pub fn open(&self) {
        *self.released.lock().unwrap() = true;
        self.release.notify_all();
    }

    pub fn close(&self) {
        *self.released.lock().unwrap() = false;
    }

    fn response(&self) {
        self.seen.store(true, std::sync::atomic::Ordering::Release);
        self.seen_waker.wake();
        let mut released = self.released.lock().unwrap();
        while !*released {
            released = self.release.wait(released).unwrap();
        }
    }
}

impl<E: EthSpec> MockBeaconNode<E> {
    pub fn panda_bootstrap_index(
        &mut self,
        pubkey: bls::PublicKeyBytes,
        index: u64,
        status: usize,
        gate: Arc<PandaBootstrapGate>,
    ) -> Mock {
        let body = if status == 200 {
            serde_json::json!({
                "execution_optimistic": false, "finalized": false,
                "data": {
                    "index": index.to_string(), "balance": "32000000000",
                    "status": "active_ongoing",
                    "validator": {
                        "pubkey": pubkey, "withdrawal_credentials": Hash256::ZERO,
                        "effective_balance": "32000000000", "slashed": false,
                        "activation_eligibility_epoch": "0", "activation_epoch": "0",
                        "exit_epoch": u64::MAX.to_string(),
                        "withdrawable_epoch": u64::MAX.to_string()
                    }
                }
            })
        } else {
            serde_json::json!({ "code": status, "message": "bootstrap fixture" })
        };
        self.server
            .mock(
                "GET",
                format!("/eth/v1/beacon/states/head/validators/{pubkey:?}").as_str(),
            )
            .with_status(status)
            .with_header("content-type", "application/json")
            .with_body_from_request(move |_| {
                gate.response();
                serde_json::to_vec(&body).unwrap()
            })
            .create()
    }

    pub fn panda_bootstrap_ptc(
        &mut self,
        epoch: Epoch,
        duties: Vec<eth2::types::PtcDuty>,
        status: usize,
        gate: Arc<PandaBootstrapGate>,
    ) -> Mock {
        self.server
            .mock(
                "POST",
                format!("/eth/v1/validator/duties/ptc/{epoch}").as_str(),
            )
            .with_status(status)
            .with_header("content-type", "application/json")
            .with_body_from_request(move |request| {
                let indices: Vec<String> = serde_json::from_slice(request.body().unwrap()).unwrap();
                gate.response();
                if status != 200 {
                    return br#"{"code":503,"message":"bootstrap fixture"}"#.to_vec();
                }
                let data = duties
                    .iter()
                    .filter(|duty| {
                        indices
                            .iter()
                            .any(|index| index == &duty.validator_index.to_string())
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                serde_json::to_vec(&eth2::types::DutiesResponse {
                    dependent_root: Hash256::repeat_byte(17),
                    execution_optimistic: Some(false),
                    data,
                })
                .unwrap()
            })
            .create()
    }
}
