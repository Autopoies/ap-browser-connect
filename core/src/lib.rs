//! ap-browser-core — shared protocol + frame codec.
//!
//! Used by both `ap-browser` (CLI) and `ap-browser-host`.

pub mod frame;
pub mod protocol;
pub mod transport;

pub use frame::{encode, read_frame, FrameError, MAX_FRAME_SIZE};
pub use protocol::{
    Error, ErrorResponse, FocusSnapshot, HelloParams, Meta, OperatedTarget, ProfileRef, Request,
    Response, RpcResult, SuccessResponse, TabRef,
};
