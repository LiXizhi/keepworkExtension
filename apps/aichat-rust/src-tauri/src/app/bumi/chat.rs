// The trusted main document may request a classroom task. Only the locally
// enabled Bumi window can claim it, run it and return its receipt.
use super::{trusted_page, Control, LABEL};
use crate::app::{launch::trusted_main_document_origin, state::AppCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager, WebviewWindow};
use tokio::sync::oneshot;
use uuid::Uuid;

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Operation {
    Start,
    Clarify,
    Status,
    Stop,
    Observe,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ClassroomRequest {
    operation: Operation,
    task_id: Option<String>,
    after_task_id: Option<String>,
    command: Option<String>,
    global: Option<bool>,
}

impl ClassroomRequest {
    fn emergency_stop(&self) -> bool {
        self.operation == Operation::Stop && (self.task_id.is_none() || self.global == Some(true))
    }

    fn valid(&self) -> bool {
        if self.operation != Operation::Stop && self.global.is_some() {
            return false;
        }
        if let Some(previous) = &self.after_task_id {
            if self.operation != Operation::Start
                || self.task_id.as_ref() == Some(previous)
                || Uuid::parse_str(previous).is_err()
            {
                return false;
            }
        }
        let has_id = self.task_id.is_some();
        if self
            .task_id
            .as_ref()
            .is_some_and(|id| Uuid::parse_str(id).is_err())
        {
            return false;
        }
        let words = self.command.as_deref();
        match self.operation {
            Operation::Start | Operation::Clarify => {
                has_id
                    && words.is_some_and(|w| {
                        !w.trim().is_empty()
                            && w.chars().count() <= 120
                            && !w.chars().any(char::is_control)
                    })
            }
            Operation::Status => has_id && words.is_none(),
            Operation::Stop | Operation::Observe => words.is_none(),
        }
    }
}

struct Pending {
    origin: String,
    document: String,
    command: Option<ClassroomRequest>,
    result: oneshot::Sender<Value>,
}

#[derive(Default)]
pub(super) struct Bridge {
    connection: Option<String>,
    stop_only: Option<String>,
    pending: HashMap<String, Pending>,
}

struct Guard<'a>(&'a Mutex<Bridge>, String);
impl Drop for Guard<'_> {
    fn drop(&mut self) {
        self.0.lock().unwrap().pending.remove(&self.1);
    }
}

fn unavailable(reason: &str) -> Value {
    json!({"status":"unavailable", "message":reason})
}

pub(crate) fn invalidate_main(app: &tauri::AppHandle) {
    let Some(control) = app.try_state::<Arc<Control>>() else {
        return;
    };
    let enabled = {
        let mut chat = control.chat.lock().unwrap();
        let enabled = chat.connection.is_some();
        let stop_only = chat.connection.take().or_else(|| chat.stop_only.take());
        *chat = Bridge {
            stop_only,
            ..Default::default()
        };
        enabled
    };
    if enabled {
        let _ = app.emit_to(LABEL, "bumi:classroom-revoked", ());
    }
}

#[tauri::command]
pub(crate) async fn desktop_bumi_classroom(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    control: tauri::State<'_, Arc<Control>>,
    document: String,
    token: String,
    request: ClassroomRequest,
) -> Result<Value, String> {
    let origin = trusted_main_document_origin(&window, &state)?;
    {
        let mut intents = state.launch_intents.lock().unwrap();
        intents.authenticate(&token)?;
        intents.bind_document(&document, &origin)?;
    }
    if !request.valid() {
        return Err("课堂任务参数无效。".into());
    }
    let Some(bumi) = window.app_handle().get_webview_window(LABEL) else {
        return Ok(unavailable(
            "请在桌面「视图 → Bumi 机器人」中连接并允许主聊天使用本次连接。",
        ));
    };
    if !bumi.url().is_ok_and(|url| trusted_page(bumi.label(), &url)) {
        return Err("Bumi 控制窗口来源无效。".into());
    }
    let focus = matches!(
        request.operation,
        Operation::Start | Operation::Clarify | Operation::Observe
    );
    let ticket = Uuid::new_v4().to_string();
    let (reply, receipt) = oneshot::channel();
    {
        let mut chat = control.chat.lock().unwrap();
        let emergency = request.emergency_stop() && chat.stop_only.is_some();
        if chat.connection.is_none() && !emergency {
            return Ok(unavailable(
                "请在已连接的 Bumi 控制窗口允许主聊天使用本次连接。",
            ));
        }
        if chat.pending.len() >= 16 && request.operation != Operation::Stop {
            return Err("Bumi 请求尚未处理，请稍后查询状态。".into());
        }
        chat.pending.insert(
            ticket.clone(),
            Pending {
                origin: origin.clone(),
                document: document.clone(),
                command: Some(request),
                result: reply,
            },
        );
    }
    let _guard = Guard(&control.chat, ticket.clone());
    if focus {
        bumi.unminimize()
            .and_then(|()| bumi.show())
            .and_then(|()| bumi.set_focus())
            .map_err(|e| e.to_string())?;
    }
    bumi.emit_to(LABEL, "bumi:classroom-request", ticket)
        .map_err(|e| e.to_string())?;
    let result = tokio::time::timeout(Duration::from_secs(15), receipt)
        .await
        .map_err(|_| "未收到 Bumi 窗口回执。请按原任务 ID 查询状态，勿重复提交。")?
        .map_err(|_| "本次控制授权已结束。")?;
    if !state
        .launch_intents
        .lock()
        .unwrap()
        .current_document(&document, &origin)
    {
        return Err("主聊天页面已切换。".into());
    }
    Ok(result)
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Handoff {
    Enable {
        #[serde(rename = "connectionId")]
        connection: String,
    },
    Disable,
    StopConnection {
        #[serde(rename = "connectionId")]
        connection: String,
    },
    Claim {
        ticket: String,
    },
    Reply {
        ticket: String,
        result: Value,
    },
}

#[tauri::command]
pub(crate) async fn bumi_chat_handoff(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<AppCore>>,
    control: tauri::State<'_, Arc<Control>>,
    request: Handoff,
) -> Result<Value, String> {
    if !window
        .url()
        .is_ok_and(|url| trusted_page(window.label(), &url))
    {
        return Err("只能由本地 Bumi 控制窗口接收课堂任务。".into());
    }
    match request {
        Handoff::Enable { connection } => {
            #[cfg(any(target_os = "macos", windows))]
            {
                if !window.is_focused().unwrap_or(false) {
                    return Err("请在 Bumi 窗口启用控制。".into());
                }
                let owner = control
                    .window
                    .lock()
                    .unwrap()
                    .as_ref()
                    .ok_or("Bumi 窗口已关闭。")?
                    .subscribe();
                let ble = control
                    .bluetooth
                    .try_lock()
                    .map_err(|_| "请等蓝牙操作完成。")?;
                if !ble.owned_by(&owner)
                    || ble.snapshot().connection_id.as_deref() != Some(&connection)
                {
                    return Err("机器人连接已改变。".into());
                }
                *control.chat.lock().unwrap() = Bridge {
                    connection: Some(connection),
                    ..Default::default()
                };
            }
            #[cfg(not(any(target_os = "macos", windows)))]
            {
                let _ = connection;
                return Err(super::UNSUPPORTED.into());
            }
        }
        Handoff::StopConnection { connection } => {
            #[cfg(any(target_os = "macos", windows))]
            {
                let owner = control
                    .window
                    .lock()
                    .unwrap()
                    .as_ref()
                    .ok_or("Bumi 窗口已关闭。")?
                    .subscribe();
                let mut ble = control.bluetooth.lock().await;
                if !ble.owned_by(&owner)
                    || ble.snapshot().connection_id.as_deref() != Some(&connection)
                {
                    return Err("原机器人连接已改变。".into());
                }
                let stopped = ble
                    .request(
                        window.app_handle(),
                        super::Request::Send {
                            command: super::Command::STOP,
                            remote_capture_id: None,
                            voice_id: None,
                        },
                        owner.clone(),
                        owner,
                        None,
                        || Ok(()),
                    )
                    .await?;
                if stopped.connection_id.as_deref() != Some(&connection) || stopped.moving {
                    return Err("原机器人未确认停止指令。".into());
                }
            }
            #[cfg(not(any(target_os = "macos", windows)))]
            {
                let _ = connection;
                return Err(super::UNSUPPORTED.into());
            }
        }
        Handoff::Disable => *control.chat.lock().unwrap() = Bridge::default(),
        Handoff::Claim { ticket } => {
            let mut bridge = control.chat.lock().unwrap();
            let granted = bridge.connection.is_some();
            let connection = bridge
                .connection
                .clone()
                .or_else(|| bridge.stop_only.clone())
                .ok_or("控制授权已撤销。")?;
            let pending = bridge.pending.get_mut(&ticket).ok_or("请求已过期。")?;
            if !state
                .launch_intents
                .lock()
                .unwrap()
                .current_document(&pending.document, &pending.origin)
            {
                return Err("主聊天页面已切换。".into());
            }
            let request = pending.command.take().ok_or("请求已处理。")?;
            if !granted && !request.emergency_stop() {
                return Err("控制授权已撤销。".into());
            }
            return Ok(
                json!({"request":request, "document":pending.document, "connection":connection}),
            );
        }
        Handoff::Reply { ticket, result } => {
            let mut bridge = control.chat.lock().unwrap();
            let pending = bridge.pending.remove(&ticket).ok_or("请求已过期。")?;
            if pending.command.is_some() {
                return Err("请求未被接收。".into());
            }
            let _ = pending.result.send(result);
        }
    }
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_bounded_typed_requests_with_valid_task_ids_are_allowed() {
        for (json, valid) in [
            (json!({"operation":"observe"}), true),
            (json!({"operation":"stop"}), true),
            (
                json!({"operation":"start","taskId":Uuid::new_v4().to_string(),"command":"往前走一步"}),
                true,
            ),
            (json!({"operation":"start","command":"握手"}), false),
            (json!({"operation":"status","taskId":"bad"}), false),
            (json!({"operation":"stop","command":"forward"}), false),
            (json!({"operation":"observe","global":true}), false),
            (
                json!({"operation":"stop","taskId":Uuid::new_v4().to_string(),"global":true}),
                true,
            ),
            (
                json!({"operation":"start","taskId":Uuid::new_v4().to_string(),"afterTaskId":Uuid::new_v4().to_string(),"command":"握个手"}),
                true,
            ),
            (
                json!({"operation":"stop","afterTaskId":Uuid::new_v4().to_string()}),
                false,
            ),
            (json!({"operation":"send","command":"walk"}), false),
            (json!({"operation":"observe","vx":50}), false),
        ] {
            assert_eq!(
                serde_json::from_value::<ClassroomRequest>(json).is_ok_and(|r| r.valid()),
                valid
            );
        }
    }
}
