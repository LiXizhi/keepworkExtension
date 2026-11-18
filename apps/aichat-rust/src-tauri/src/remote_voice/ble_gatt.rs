//! Metadata only: never read characteristic values or probe unknown commands.
use super::{AUDIO, CONTROL, SERVICE, TX};
use btleplug::api::{Characteristic, Service};
use std::collections::BTreeSet;

pub(super) struct Channels {
    pub tx: Characteristic,
    pub control: Characteristic,
    pub audio: Characteristic,
}

pub(super) fn channels(chars: &BTreeSet<Characteristic>) -> Option<Channels> {
    let find = |id| chars.iter().find(|c| c.service_uuid == SERVICE && c.uuid == id).cloned();
    Some(Channels { tx: find(TX)?, control: find(CONTROL)?, audio: find(AUDIO)? })
}

pub(super) fn report(device: &str, services: &BTreeSet<Service>, chars: &BTreeSet<Characteristic>) -> String {
    let mut lines = vec![
        format!("{} {} / {} / {}", env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH),
        format!("设备 ID：{}", device.chars().filter(|c| !c.is_control()).take(256).collect::<String>()),
        format!("预期 ATVV 服务：{SERVICE}"),
    ];
    let missing: Vec<_> = [(TX, "TX"), (AUDIO, "AUDIO"), (CONTROL, "CONTROL")].into_iter()
        .filter(|(id, _)| !chars.iter().any(|c| c.service_uuid == SERVICE && c.uuid == *id))
        .map(|(id, name)| format!("{name} ({id})")).collect();
    lines.push(if missing.is_empty() { "ATVV 通道：完整（音频能力需另行协商）".into() }
        else { format!("未发现通道：{}", missing.join(", ")) });
    let ids: BTreeSet<_> = services.iter().map(|s| s.uuid).chain(chars.iter().map(|c| c.service_uuid)).collect();
    lines.push(format!("发现 {} 个服务 / {} 个特征（最多显示 32 个服务、64 个特征）：", ids.len(), chars.len()));
    let mut remaining = 64;
    for id in ids.iter().take(32) {
        lines.push(format!("Service {id}"));
        for ch in chars.iter().filter(|c| c.service_uuid == *id).take(remaining) {
            lines.push(format!("  {} {:?}", ch.uuid, ch.properties));
            remaining -= 1;
        }
    }
    if ids.len() > 32 || chars.len() > 64 { lines.push("诊断已截断。".into()); }
    lines.push("仅服务元信息；不含录音、转写或特征值。".into());
    lines.join("\n").chars().take(12_000).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use btleplug::api::CharPropFlags;
    use uuid::Uuid;

    fn characteristic(service_uuid: Uuid, uuid: Uuid) -> Characteristic {
        Characteristic { uuid, service_uuid, properties: CharPropFlags::READ | CharPropFlags::NOTIFY,
            descriptors: BTreeSet::new() }
    }
    fn complete() -> BTreeSet<Characteristic> {
        [TX, CONTROL, AUDIO].into_iter().map(|id| characteristic(SERVICE, id)).collect()
    }

    #[test]
    fn complete_atvv_and_each_missing_channel_are_distinguished() {
        let all = complete();
        let found = channels(&all).unwrap();
        assert_eq!((found.tx.uuid, found.control.uuid, found.audio.uuid), (TX, CONTROL, AUDIO));
        assert!(report("remote", &BTreeSet::new(), &all).contains("通道：完整"));
        for (id, name) in [(TX, "TX"), (AUDIO, "AUDIO"), (CONTROL, "CONTROL")] {
            let partial = all.iter().filter(|ch| ch.uuid != id).cloned().collect();
            assert!(channels(&partial).is_none());
            let report = report("remote", &BTreeSet::new(), &partial);
            assert!(report.contains(&format!("未发现通道：{name} ({id})")));
        }
    }

    #[test]
    fn same_characteristic_ids_in_other_services_cannot_select_a_protocol() {
        let other = Uuid::from_u128(0x1812);
        let chars = [TX, AUDIO, CONTROL].into_iter().map(|id| characteristic(other, id)).collect();
        assert!(channels(&chars).is_none());
        let report = report("remote", &BTreeSet::new(), &chars);
        assert!(report.contains("未发现通道：TX"));
        assert!(report.contains(&format!("Service {other}")));
        assert!(report.contains("NOTIFY"));
    }

    #[test]
    fn empty_hid_only_and_metadata_bounds_do_not_require_value_reads() {
        let hid = Service { uuid: Uuid::from_u128(0x1812), primary: true, characteristics: BTreeSet::new() };
        let report = report("remote", &[hid].into(), &BTreeSet::new());
        assert!(report.contains("1 个服务 / 0 个特征"));
        assert!(channels(&BTreeSet::new()).is_none());
        let chars = (1..=500).map(|id| characteristic(Uuid::from_u128(id / 100), Uuid::from_u128(id))).collect();
        let report = super::report(&"语\n".repeat(20_000), &BTreeSet::new(), &chars);
        assert!(report.chars().count() <= 12_000);
        assert_eq!(report.lines().filter(|line| line.starts_with("  ")).count(), 64);
        assert!(report.contains("诊断已截断"));
        assert!(report.lines().nth(1).unwrap().chars().count() < 270);
    }
}
