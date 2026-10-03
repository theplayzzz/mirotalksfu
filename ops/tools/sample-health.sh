#!/bin/bash
# Samples server health once per second: per mediasoup-worker CPU (each worker is single-threaded),
# NIC throughput/packets, CPU steal and softirq; UDP error counters before/after.
# usage: sudo bash sample-health.sh [seconds]
N=${1:-60}
IF=$(ip route | awk '/default/ {print $5; exit}')
HZ=$(getconf CLK_TCK)
pids=$(pgrep -f mediasoup-worker | tr '\n' ' ')
snap() {
    local w=""
    for p in $pids; do w+="$(awk '{print $14+$15}' /proc/$p/stat 2>/dev/null || echo 0) "; done
    echo "$w|$(awk -v i="$IF:" '$1==i {print $2, $10, $3, $11}' /proc/net/dev)|$(awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8+$9, $9, $8}' /proc/stat)"
}
udp() { awk '/^Udp:/ {n++} n==2 {print "InErrors=" $4, "RcvbufErrors=" $6, "SndbufErrors=" $7; exit}' /proc/net/snmp; }
echo "UDP before: $(udp)"
printf "%-4s %-22s %8s %8s %8s %8s %6s %6s\n" t "worker_cpu%" rx_Mbps tx_Mbps rx_kpps tx_kpps steal% sirq%
prev=$(snap)
for ((t=1; t<=N; t++)); do
    sleep 1
    cur=$(snap)
    awk -v t=$t -v hz=$HZ -v a="$prev" -v b="$cur" 'BEGIN {
        split(a, A, "|"); split(b, B, "|");
        nw = split(A[1], wa, " "); split(B[1], wb, " "); w = "";
        for (i = 1; i <= nw; i++) w = w int((wb[i] - wa[i]) * 100 / hz) " ";
        split(A[2], na, " "); split(B[2], nb, " "); split(A[3], ca, " "); split(B[3], cb, " ");
        dt = cb[1] - ca[1]; if (dt == 0) dt = 1;
        printf "%-4s %-22s %8.1f %8.1f %8.1f %8.1f %6.1f %6.1f\n", t, w, (nb[1]-na[1])*8/1e6, (nb[2]-na[2])*8/1e6, (nb[3]-na[3])/1e3, (nb[4]-na[4])/1e3, (cb[2]-ca[2])*100/dt, (cb[3]-ca[3])*100/dt
    }'
    prev=$cur
done
echo "UDP after:  $(udp)"
