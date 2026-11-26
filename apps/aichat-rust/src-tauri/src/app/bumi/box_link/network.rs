use std::net::Ipv4Addr;

#[derive(Clone, Copy, Ord, PartialOrd, Eq, PartialEq)]
pub(super) struct Interface {
    pub(super) ip: Ipv4Addr,
    mask: u32,
}

impl Interface {
    pub(super) fn with_prefix(ip: Ipv4Addr, prefix: u8) -> Option<Self> {
        if !usable_address(ip) || !(1..=32).contains(&prefix) {
            return None;
        }
        Some(Self {
            ip,
            mask: u32::MAX << (32 - prefix),
        })
    }

    fn network(self) -> u32 {
        u32::from(self.ip) & self.mask
    }

    pub(super) fn broadcast(self) -> Option<Ipv4Addr> {
        (self.mask < 0xffff_fffe).then(|| (self.network() | !self.mask).into())
    }

    pub(super) fn peer(self, ip: Ipv4Addr) -> bool {
        usable_address(ip)
            && ip != self.ip
            && u32::from(ip) & self.mask == self.network()
            && (self.broadcast().is_none()
                || (Some(ip) != self.broadcast() && u32::from(ip) != self.network()))
    }

    pub(super) fn scan_addresses(self) -> impl Iterator<Item = Ipv4Addr> {
        let base = u32::from(self.ip) & 0xffff_ff00;
        (1..255)
            .map(move |host| Ipv4Addr::from(base | host))
            .filter(move |ip| self.peer(*ip))
    }
}

pub(super) fn usable_address(ip: Ipv4Addr) -> bool {
    let first = ip.octets()[0];
    first != 0 && first < 224 && !ip.is_loopback() && !ip.is_link_local()
}

#[cfg(unix)]
pub(super) fn interfaces() -> Vec<Interface> {
    use std::ptr;

    let mut first = ptr::null_mut();
    // getifaddrs owns the linked list until freeifaddrs.
    unsafe {
        if libc::getifaddrs(&mut first) != 0 {
            return Vec::new();
        }
        let mut result = Vec::new();
        let mut next = first;
        while let Some(entry) = next.as_ref() {
            next = entry.ifa_next;
            let Some(address) = entry.ifa_addr.as_ref() else {
                continue;
            };
            if entry.ifa_flags & libc::IFF_UP as u32 == 0
                || entry.ifa_flags & libc::IFF_LOOPBACK as u32 != 0
                || i32::from(address.sa_family) != libc::AF_INET
                || entry.ifa_netmask.is_null()
            {
                continue;
            }
            let address = &*entry.ifa_addr.cast::<libc::sockaddr_in>();
            let mask = &*entry.ifa_netmask.cast::<libc::sockaddr_in>();
            let ip = Ipv4Addr::from(address.sin_addr.s_addr.to_ne_bytes());
            let prefix = u32::from_be(mask.sin_addr.s_addr).leading_ones() as u8;
            result.extend(Interface::with_prefix(ip, prefix));
        }
        libc::freeifaddrs(first);
        result
    }
}

#[cfg(unix)]
pub(super) async fn arp_addresses() -> Vec<Ipv4Addr> {
    let mut arp = tokio::process::Command::new("/usr/sbin/arp");
    arp.arg("-an").kill_on_drop(true);
    let Ok(Ok(output)) =
        tokio::time::timeout(std::time::Duration::from_millis(500), arp.output()).await
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|row| row.split_once('(')?.1.split_once(')')?.0.parse().ok())
        .collect()
}

#[cfg(windows)]
pub(super) fn interfaces() -> Vec<Interface> {
    use std::{mem::size_of, ptr};
    use windows_sys::Win32::{
        Foundation::ERROR_BUFFER_OVERFLOW,
        NetworkManagement::{
            IpHelper::{
                GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
                GAA_FLAG_SKIP_MULTICAST, IF_TYPE_SOFTWARE_LOOPBACK, IP_ADAPTER_ADDRESSES_LH,
            },
            Ndis::IfOperStatusUp,
        },
        Networking::WinSock::{AF_INET, SOCKADDR_IN},
    };

    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    let mut length = 15_000;
    for _ in 0..3 {
        // Use aligned storage for the structures and pointers returned in this buffer.
        let mut buffer = vec![0u64; (length as usize).div_ceil(size_of::<u64>())];
        let first = buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
        let status = unsafe {
            GetAdaptersAddresses(u32::from(AF_INET), flags, ptr::null(), first, &mut length)
        };
        if status == ERROR_BUFFER_OVERFLOW && length <= 1024 * 1024 {
            continue;
        }
        if status != 0 {
            break;
        }
        let mut result = Vec::new();
        unsafe {
            let mut next = first;
            while let Some(adapter) = next.as_ref() {
                next = adapter.Next;
                if adapter.OperStatus != IfOperStatusUp
                    || adapter.IfType == IF_TYPE_SOFTWARE_LOOPBACK
                {
                    continue;
                }
                let mut unicast = adapter.FirstUnicastAddress;
                while let Some(entry) = unicast.as_ref() {
                    unicast = entry.Next;
                    let Some(address) = entry.Address.lpSockaddr.as_ref() else {
                        continue;
                    };
                    if address.sa_family != AF_INET
                        || entry.Address.iSockaddrLength < size_of::<SOCKADDR_IN>() as i32
                    {
                        continue;
                    }
                    let address = &*entry.Address.lpSockaddr.cast::<SOCKADDR_IN>();
                    let ip = Ipv4Addr::from(address.sin_addr.S_un.S_addr.to_ne_bytes());
                    result.extend(Interface::with_prefix(ip, entry.OnLinkPrefixLength));
                }
            }
        }
        return result;
    }
    Vec::new()
}

#[cfg(windows)]
pub(super) async fn arp_addresses() -> Vec<Ipv4Addr> {
    use std::ptr;
    use windows_sys::Win32::{
        NetworkManagement::IpHelper::{
            FreeMibTable, GetIpNetTable2, MIB_IPNET_ROW2, MIB_IPNET_TABLE2,
        },
        Networking::WinSock::AF_INET,
    };

    // The API returns a variable-length array of rows for AF_INET.
    unsafe {
        let mut table: *mut MIB_IPNET_TABLE2 = ptr::null_mut();
        if GetIpNetTable2(AF_INET, &mut table) != 0 || table.is_null() {
            return Vec::new();
        }
        let rows = std::slice::from_raw_parts(
            ptr::addr_of!((*table).Table).cast::<MIB_IPNET_ROW2>(),
            (*table).NumEntries as usize,
        );
        let addresses = rows
            .iter()
            .filter(|row| row.PhysicalAddressLength != 0)
            .map(|row| Ipv4Addr::from(row.Address.Ipv4.sin_addr.S_un.S_addr.to_ne_bytes()))
            .collect();
        FreeMibTable(table.cast());
        addresses
    }
}
