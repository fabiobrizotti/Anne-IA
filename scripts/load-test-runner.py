#!/usr/bin/env python3
"""
Anne-IA Load Test Runner.
Stdlib only. Zero pip dependencies.
Supports:
  - Level 1: HTTP Raw throughput (n8n healthz or webhook)
  - Level 2: RabbitMQ Ingestion injection via Management API
  - Self-check mode: --check
"""
import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed


def get_auth_header(user, password):
    token = base64.b64encode(f"{user}:{password}".encode("utf-8")).decode("ascii")
    return f"Basic {token}"


def http_worker(url, timeout):
    t0 = time.perf_counter()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Anne-LoadTester/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = resp.status
            resp.read()
            dt = (time.perf_counter() - t0) * 1000.0
            return (True, dt, status)
    except Exception as exc:
        dt = (time.perf_counter() - t0) * 1000.0
        return (False, dt, str(exc))


def amqp_worker(mgmt_url, auth, exchange, routing_key, instance_id, msg_idx, timeout):
    payload_obj = {
        "event": "messages.upsert",
        "instance": instance_id,
        "data": {
            "key": {
                "remoteJid": f"55119{msg_idx:08d}@s.whatsapp.net",
                "fromMe": False,
                "id": f"LOAD_MSG_{msg_idx}_{int(time.time()*1000)}",
            },
            "pushName": f"LoadTester_{msg_idx}",
            "messageType": "conversation",
            "message": {"conversation": f"Load test ping sequence {msg_idx}"},
        },
        "date_time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sender": f"55119{msg_idx:08d}@s.whatsapp.net",
    }
    # ponytail: publish via RabbitMQ Management HTTP API avoids pika/amqp dependency; switch to raw AMQP socket if rate exceeds 3000 msgs/sec
    body = json.dumps(
        {
            "properties": {"delivery_mode": 2},
            "routing_key": routing_key,
            "payload": json.dumps(payload_obj),
            "payload_encoding": "string",
        }
    ).encode("utf-8")

    publish_url = f"{mgmt_url}/api/exchanges/%2F/{exchange}/publish"
    t0 = time.perf_counter()
    try:
        req = urllib.request.Request(
            publish_url,
            data=body,
            headers={
                "Authorization": auth,
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            dt = (time.perf_counter() - t0) * 1000.0
            routed = data.get("routed", False)
            return (routed, dt, 200 if routed else "unrouted")
    except Exception as exc:
        dt = (time.perf_counter() - t0) * 1000.0
        return (False, dt, str(exc))


def run_stage(title, concurrency, total_requests, fn):
    print(f"\n--- Stage: {title} | Concurrency: {concurrency} | Total: {total_requests} ---")
    latencies = []
    successes = 0
    failures = 0

    t_start = time.perf_counter()
    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = [executor.submit(fn, i) for i in range(total_requests)]
        for f in as_completed(futures):
            ok, dt, status = f.result()
            latencies.append(dt)
            if ok:
                successes += 1
            else:
                failures += 1

    t_total = time.perf_counter() - t_start
    latencies.sort()
    rps = total_requests / t_total if t_total > 0 else 0
    p50 = latencies[int(len(latencies) * 0.50)] if latencies else 0
    p95 = latencies[int(len(latencies) * 0.95)] if latencies else 0
    p99 = latencies[int(len(latencies) * 0.99)] if latencies else 0

    print(f"Result: {successes} ok, {failures} fail in {t_total:.2f}s | Throughput: {rps:.1f} req/s")
    print(f"Latency: p50={p50:.1f}ms | p95={p95:.1f}ms | p99={p99:.1f}ms")
    return failures == 0


def run_self_check(n8n_url, mgmt_url, auth):
    print("[Self-Check] Verificando endpoints de teste...")
    # 1. n8n healthz
    try:
        req = urllib.request.Request(f"{n8n_url}/healthz")
        with urllib.request.urlopen(req, timeout=3) as resp:
            assert resp.status == 200, f"n8n healthz status {resp.status}"
            print("[Self-Check] n8n /healthz: PASS")
    except Exception as exc:
        print(f"[Self-Check] n8n /healthz: FAIL ({exc})")
        return False

    # 2. RabbitMQ Management API
    try:
        req = urllib.request.Request(
            f"{mgmt_url}/api/overview",
            headers={"Authorization": auth},
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            assert resp.status == 200, f"RabbitMQ status {resp.status}"
            print("[Self-Check] RabbitMQ Management API: PASS")
    except Exception as exc:
        print(f"[Self-Check] RabbitMQ API: FAIL ({exc})")
        return False

    print("[Self-Check] Todos os endpoints prontos.")
    return True


def main():
    parser = argparse.ArgumentParser(description="Anne-IA Load Test Runner")
    parser.add_argument("--mode", choices=["http", "amqp"], default="http")
    parser.add_argument("--n8n-url", default="http://127.0.0.1:5678")
    parser.add_argument("--mgmt-url", default="http://127.0.0.1:15672")
    parser.add_argument("--user", default="root")
    parser.add_argument("--password", default=os.getenv("RABBITMQ_DEFAULT_PASS", ""))
    parser.add_argument("--exchange", default="evolution")
    parser.add_argument("--routing-key", default="messages.upsert")
    parser.add_argument("--instance", default="fabio")
    parser.add_argument("--check", action="store_true", help="Executa apenas checagem de conectividade")
    args = parser.parse_args()

    auth = get_auth_header(args.user, args.password)

    if args.check:
        ok = run_self_check(args.n8n_url, args.mgmt_url, auth)
        sys.exit(0 if ok else 1)

    stages = [
        (5, 50),     # 5 concorrência, 50 requisições
        (25, 250),   # 25 concorrência, 250 requisições
        (50, 500),   # 50 concorrência, 500 requisições
        (100, 1000), # 100 concorrência, 1000 requisições
    ]

    for concurrency, count in stages:
        if args.mode == "http":
            target = f"{args.n8n_url}/healthz"
            fn = lambda idx: http_worker(target, timeout=5)
        else:
            fn = lambda idx: amqp_worker(
                args.mgmt_url, auth, args.exchange, args.routing_key, args.instance, idx, timeout=10
            )

        success = run_stage(f"{args.mode.upper()} Ramp", concurrency, count, fn)
        if not success:
            print("[AVISO] Falhas detectadas no estágio. Aguardando 5s para dreno...")
            time.sleep(5)
        else:
            time.sleep(2)


if __name__ == "__main__":
    main()
