# Passive, read-only capture: per-peer media traffic of the MiroTalk room (UDP 40000-40100).
# Inbound = what each sharer uploads to the server; outbound = what each viewer downloads.
# usage: sudo python3 peer-traffic.py [seconds] [interface] [server_ip]
import socket, struct, sys, time
from collections import defaultdict

secs = int(sys.argv[1]) if len(sys.argv) > 1 else 15
ifname = sys.argv[2] if len(sys.argv) > 2 else 'ens3'
server = socket.inet_aton(sys.argv[3] if len(sys.argv) > 3 else '40.160.143.32')
LO, HI = 40000, 40100

s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.ntohs(0x0003))
s.bind((ifname, 0))
s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 64 * 1024 * 1024)
s.settimeout(0.2)
rx = defaultdict(lambda: [0] * secs)  # src ip -> bytes per second (uploads to server)
tx = defaultdict(lambda: [0] * secs)  # dst ip -> bytes per second (downloads from server)
t0 = time.time()
pk = 0
while True:
    el = time.time() - t0
    if el >= secs:
        break
    try:
        frame = s.recv(2048)
    except socket.timeout:
        continue
    if len(frame) < 42 or frame[12:14] != b'\x08\x00' or frame[23] != 17:
        continue
    ihl = (frame[14] & 15) * 4
    src, dst = frame[26:30], frame[30:34]
    sport, dport = struct.unpack('!HH', frame[14 + ihl:18 + ihl])
    ln = struct.unpack('!H', frame[16:18])[0]
    b = int(el)
    if dst == server and LO <= dport <= HI:
        rx[src][b] += ln; pk += 1
    elif src == server and LO <= sport <= HI:
        tx[dst][b] += ln; pk += 1

def mask(ip):
    p = socket.inet_ntoa(ip).split('.')
    return f'{p[0]}.{p[1]}.x.x'

def report(title, d):
    print(title)
    rows = sorted(d.items(), key=lambda kv: -sum(kv[1]))
    for ip, v in rows:
        mb = [x * 8 / 1e6 for x in v]
        avg = sum(mb) / len(mb)
        if avg < 0.2:
            continue
        print(f'  {mask(ip):<14} media {avg:6.1f}  min {min(mb):6.1f}  max {max(mb):6.1f} Mbps   por segundo: ' + ' '.join(f'{x:.0f}' for x in mb))
    print(f'  TOTAL media {sum(sum(v) for v in d.values()) * 8 / 1e6 / secs:.1f} Mbps')

print(f'captura {secs}s em {ifname}, {pk} pacotes de midia')
report('ENTRADA (upload de quem transmite -> servidor):', rx)
report('SAIDA (servidor -> download de cada espectador):', tx)
