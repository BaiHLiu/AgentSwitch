/** Who may reach the remote listener (app-v0 §2 来源地址) and which of this machine's addresses another device can use (§2 配对:
 *  `lan`). Pure apart from reading the interface table, which callers may pass in. */

import { BlockList, isIPv4, isIPv6 } from "node:net";
import { readFileSync } from "node:fs";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

/** Source networks the remote listener accepts: loopback, RFC 1918, link-local, Tailscale CGNAT, IPv6 ULA (incl.
 *  Tailscale's fd7a:115c:a1e0::/48) and IPv6 link-local. Nothing else, so there is no public surface. */
export const ALLOWED_SOURCES: readonly (readonly [string, number, "ipv4" | "ipv6"])[] = [
  ["127.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["::1", 128, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
];

/** RFC 1918 only: the `lan` addresses a phone on the same network can dial. */
const LAN_RANGES: readonly (readonly [string, number])[] = [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16]];

function blockList(ranges: readonly (readonly [string, number, "ipv4" | "ipv6"])[]): BlockList {
  const list = new BlockList();
  for (const [net, prefix, type] of ranges) list.addSubnet(net, prefix, type);
  return list;
}

const SOURCES = blockList(ALLOWED_SOURCES);
const LAN = blockList(LAN_RANGES.map(([net, prefix]) => [net, prefix, "ipv4"] as const));

/** The address as the family it really is: an IPv4-mapped IPv6 address (`::ffff:10.0.0.2`, what a dual-stack socket
 *  reports for IPv4 peers) becomes plain IPv4, and an IPv6 zone (`fe80::1%en0`) is dropped. Null when unparsable. */
export function normalizeAddress(address: string | undefined | null): { readonly address: string; readonly type: "ipv4" | "ipv6" } | null {
  if (!address) return null;
  const bare = address.replace(/%.*$/, "");
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
  if (mapped && isIPv4(mapped[1]!)) return { address: mapped[1]!, type: "ipv4" };
  if (isIPv4(bare)) return { address: bare, type: "ipv4" };
  if (isIPv6(bare)) return { address: bare.toLowerCase(), type: "ipv6" };
  return null;
}

/** True when a peer at `address` may talk to the remote listener. Unknown or unparsable → false (fail closed). */
export function isAllowedSource(address: string | undefined | null): boolean {
  const a = normalizeAddress(address);
  return !!a && SOURCES.check(a.address, a.type);
}

/** The part of a socket the connection guard looks at; a fake in tests. */
export type GuardedSocket = { readonly remoteAddress?: string | undefined; destroy(): unknown };

/** `connection` hook: a socket from outside the allowed networks is destroyed before TLS starts. Returns whether the
 *  socket was kept. */
export function guardConnection(socket: GuardedSocket, allow: (address: string | undefined) => boolean = isAllowedSource): boolean {
  if (allow(socket.remoteAddress)) return true;
  socket.destroy();
  return false;
}

/** Interfaces that container and VM software makes on the machine itself: Docker's `docker0` and `br-<id>`, veth
 *  pairs, libvirt, VMware, VirtualBox, Podman, CNI, LXC/LXD, Kubernetes overlays. Their addresses lead to no other
 *  device; a Linux workstation has a dozen of them, more than a payload may carry (mesh-v0 §4.7). */
const VIRTUAL_INTERFACE = /^(docker\d|br-[0-9a-f]{6,}|veth|virbr|vmnet|vboxnet|podman|cni|flannel|cali|lxcbr|lxdbr|kube|weave|tunl)/;
/** At most this many addresses of each kind go in a pairing payload (the schema's limit). */
export const ADDRESS_LIMIT = 16;
const OVERLAY = blockList([["100.64.0.0", 10, "ipv4"]]);

type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

function ipv4Of(interfaces: Interfaces, keep: (name: string, address: string) => boolean): string[] {
  const found = Object.entries(interfaces).flatMap(([name, list]) => (list ?? [])
    .filter((i) => i.family === "IPv4" && !i.internal && keep(name, i.address))
    .map((i) => i.address));
  return [...new Set(found)];
}

/** This machine's private IPv4 addresses (RFC 1918, not internal, not on a container or VM interface): the
 *  interfaces of the default route first (`first`, best first), the rest in interface order; no duplicates. */
export function lanAddresses(interfaces: Interfaces = networkInterfaces(), first: readonly string[] = defaultRouteInterfaces()): string[] {
  const rank = (name: string) => { const i = first.indexOf(name); return i < 0 ? first.length : i; };
  const ordered = Object.keys(interfaces).map((name, i) => ({ name, i })).sort((a, b) => rank(a.name) - rank(b.name) || a.i - b.i);
  const sorted = Object.fromEntries(ordered.map(({ name }) => [name, interfaces[name]]));
  return ipv4Of(sorted, (name, address) => !VIRTUAL_INTERFACE.test(name) && LAN.check(address, "ipv4")).slice(0, ADDRESS_LIMIT);
}

/** Overlay addresses in 100.64/10 (Tailscale, NetBird, Headscale): reachable from the other devices on that overlay
 *  network. Tailscale's own come from its CLI as well; this finds the others. */
export function overlayAddresses(interfaces: Interfaces = networkInterfaces()): string[] {
  return ipv4Of(interfaces, (name, address) => !VIRTUAL_INTERFACE.test(name) && OVERLAY.check(address, "ipv4"));
}

/** The interfaces Linux routes the default route through, lowest metric first (`/proc/net/route`); [] elsewhere. */
export function defaultRouteInterfaces(table: () => string = () => readFileSync("/proc/net/route", "utf8")): string[] {
  let text: string;
  try { text = table(); } catch { return []; }
  const routes = text.split("\n").slice(1).map((line) => line.trim().split(/\s+/))
    .filter((f) => f.length > 7 && f[1] === "00000000" && f[7] === "00000000")
    .map((f) => ({ name: f[0]!, metric: Number(f[6]) || 0 }));
  return [...new Set(routes.sort((a, b) => a.metric - b.metric).map((r) => r.name))];
}

/** `AGENTSWITCH_LAN`: the addresses to offer instead of the ones found, comma-separated, each an IPv4 address or an
 *  interface name (its private IPv4 addresses). Only addresses the remote listener accepts are kept; null when unset
 *  or empty, so discovery goes on. */
export function lanOverride(spec: string | undefined, interfaces: Interfaces = networkInterfaces()): string[] | null {
  const items = (spec ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!items.length) return null;
  const found = items.flatMap((item) => isIPv4(item) ? [item]
    : (interfaces[item] ?? []).filter((i) => i.family === "IPv4" && !i.internal).map((i) => i.address));
  return [...new Set(found)].filter((a) => isAllowedSource(a) && !a.startsWith("127.")).slice(0, ADDRESS_LIMIT);
}
