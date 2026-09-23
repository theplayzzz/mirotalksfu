#!/bin/sh
set -eu

IPTABLES=/usr/sbin/iptables
PORT_RANGE=40200:40300
RULE_COMMENT=mirotalksfu-dev-media

add_rule() {
    protocol="$1"
    if "$IPTABLES" -C DOCKER-USER -i eth0 -p "$protocol" -m conntrack --ctorigdstport "$PORT_RANGE" -m comment --comment "$RULE_COMMENT" -j RETURN 2>/dev/null; then
        return
    fi

    drop_line="$($IPTABLES -L DOCKER-USER -n --line-numbers | awk '$2 == "DROP" { print $1; exit }')"
    if [ -n "$drop_line" ]; then
        "$IPTABLES" -I DOCKER-USER "$drop_line" -i eth0 -p "$protocol" -m conntrack --ctorigdstport "$PORT_RANGE" -m comment --comment "$RULE_COMMENT" -j RETURN
    else
        "$IPTABLES" -A DOCKER-USER -i eth0 -p "$protocol" -m conntrack --ctorigdstport "$PORT_RANGE" -m comment --comment "$RULE_COMMENT" -j RETURN
    fi
}

remove_rule() {
    protocol="$1"
    while "$IPTABLES" -C DOCKER-USER -i eth0 -p "$protocol" -m conntrack --ctorigdstport "$PORT_RANGE" -m comment --comment "$RULE_COMMENT" -j RETURN 2>/dev/null; do
        "$IPTABLES" -D DOCKER-USER -i eth0 -p "$protocol" -m conntrack --ctorigdstport "$PORT_RANGE" -m comment --comment "$RULE_COMMENT" -j RETURN
    done
}

case "${1:-}" in
    start)
        add_rule udp
        add_rule tcp
        ;;
    stop)
        remove_rule udp
        remove_rule tcp
        ;;
    *)
        echo "usage: $0 {start|stop}" >&2
        exit 2
        ;;
esac
