// Test-only HTTP fixture. Production PTC polling parses and installs these duties.
impl<E: EthSpec> MockBeaconNode<E> {
    pub fn panda_ptc_duties(
        &mut self,
        epoch: Epoch,
        duty: eth2::types::PtcDuty,
        requests: Arc<std::sync::atomic::AtomicUsize>,
    ) -> Mock {
        self.server
            .mock("POST", format!("/eth/v1/validator/duties/ptc/{epoch}").as_str())
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body_from_request(move |request| {
                let indices: Vec<String> = serde_json::from_slice(request.body().unwrap()).unwrap();
                assert_eq!(indices, vec![duty.validator_index.to_string()]);
                requests.fetch_add(1, std::sync::atomic::Ordering::Release);
                serde_json::to_vec(&eth2::types::DutiesResponse {
                    dependent_root: Hash256::repeat_byte(17),
                    execution_optimistic: Some(false),
                    data: vec![duty.clone()],
                }).unwrap()
            })
            .create()
    }
}
