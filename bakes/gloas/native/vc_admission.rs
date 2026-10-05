//! Keymanager writes retain admission in the actual blocking task, even after HTTP cancellation.
use serde::Serialize;
use warp::reply::{Reply, Response};

pub async fn blocking_response_task<F, T>(func: F) -> Result<Response, warp::Rejection>
where
    F: FnOnce() -> Result<T, warp::Rejection> + Send + 'static,
    T: Reply + Send + 'static,
{
    let guard = slot_clock::controlled::try_work().ok_or_else(|| {
        warp_utils::reject::custom_bad_request("Panda validator writes are parked".into())
    })?;
    warp_utils::task::blocking_response_task(move || {
        let _guard = guard;
        func()
    })
    .await
}

pub async fn blocking_json_task<F, T>(func: F) -> Response
where
    F: FnOnce() -> Result<T, warp::Rejection> + Send + 'static,
    T: Serialize + Send + 'static,
{
    let result =
        blocking_response_task(move || func().map(|value| warp::reply::json(&value))).await;
    warp_utils::reject::convert_rejection(result).await
}
