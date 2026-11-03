//! 协议 fixture 向量生成器（一次性工具，不进中继仓库的运行时）。
//!
//! 本文件里的 `channel_hash` / `wrap_role` / `wrap_signing_bytes` / `record_keys` /
//! `seal_frame` 是**逐字复制**自 gosslan 主仓 `src-tauri/src/transport/relay_seal.rs`
//! （973b4df3 时点）与 `network/transport/relay.rs` 的 `relay_epoch_day` / `relay_preamble`。
//! 用途：用与客户端**完全相同的 crate 版本**算出确定性测试向量，写进
//! gosslan-relay-server 的 `protocol.fixtures.json`，供两边的对照测试共用。

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};

// ── 与 relay_seal.rs 逐字同源的常量与函数 ────────────────────────────────
pub const CHANNEL_PREFIX: &[u8] = b"gosslan-relay-ch-v1";
pub const WRAP_PREFIX: &[u8] = b"gosslan-relay-wrap-v1";
pub const RECORD_PREFIX: &[u8] = b"gosslan-relay-record-v1";
pub const WRAP_MAGIC: &str = "GSRW1";

pub fn channel_hash(
    my_ed25519_b64: &str,
    peer_ed25519_b64: &str,
    my_device_id: &str,
    peer_device_id: &str,
    epoch_day: u64,
) -> [u8; 32] {
    let (first_id, first_pk, second_id, second_pk) = if my_device_id <= peer_device_id {
        (my_device_id, my_ed25519_b64, peer_device_id, peer_ed25519_b64)
    } else {
        (peer_device_id, peer_ed25519_b64, my_device_id, my_ed25519_b64)
    };
    let mut h = Sha256::new();
    h.update(CHANNEL_PREFIX);
    for field in [first_id, first_pk, second_id, second_pk] {
        h.update(field.as_bytes());
        h.update([0u8]);
    }
    h.update(epoch_day.to_be_bytes());
    h.finalize().into()
}

pub fn wrap_role(my_device_id: &str, peer_device_id: &str) -> &'static str {
    if my_device_id <= peer_device_id { "A" } else { "B" }
}

pub fn wrap_signing_bytes(
    my_device_id: &str,
    peer_device_id: &str,
    channel_hex: &str,
    role: &str,
    eph_pub_b64: &str,
) -> Vec<u8> {
    serde_json::to_vec(&(
        WRAP_PREFIX,
        my_device_id,
        peer_device_id,
        channel_hex,
        role,
        eph_pub_b64,
    ))
    .expect("元组序列化不会失败")
}

fn record_keys(dh: &[u8; 32], channel_hex: &str) -> ([u8; 32], [u8; 32]) {
    let derive = |dir: &[u8]| {
        let mut h = Sha256::new();
        h.update(RECORD_PREFIX);
        h.update(dh);
        h.update(channel_hex.as_bytes());
        h.update([0u8]);
        h.update(dir);
        h.finalize().into()
    };
    (derive(b"a2b"), derive(b"b2a"))
}

/// 与 RecordSeal::seal_frame 同形：返回 `nonce(12B) || 密文 || 标签`。
fn seal_frame(key: &[u8; 32], ctr: u64, frame: &[u8]) -> Vec<u8> {
    let mut pt = Vec::with_capacity(8 + frame.len());
    pt.extend_from_slice(&ctr.to_be_bytes());
    pt.extend_from_slice(frame);
    let mut nonce = [0u8; 12];
    nonce[4..].copy_from_slice(&ctr.to_be_bytes());
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), pt.as_slice())
        .expect("加密不会失败");
    let mut out = Vec::with_capacity(12 + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    out
}

// ── relay.rs 的 relay_epoch_day（负值钳到 0）─────────────────────────────
fn relay_epoch_day(now_ms: i64) -> u64 {
    if now_ms < 0 { 0 } else { (now_ms / 86_400_000) as u64 }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn main() {
    // 固定测试身份（仅 fixture 用，公开值，不是任何真实设备）。
    let id_a = "gosslan-fixture-aaa";
    let id_b = "gosslan-fixture-bbb";
    let seed_a = SigningKey::from_bytes(b"gosslan-fixture-ed25519-A-seed-1");
    let seed_b = SigningKey::from_bytes(b"gosslan-fixture-ed25519-B-seed-1");
    let pk_a = STANDARD.encode(seed_a.verifying_key().to_bytes());
    let pk_b = STANDARD.encode(seed_b.verifying_key().to_bytes());

    // 固定临时 X25519（生产是随机的；向量里必须确定）。
    let eph_a_sec = StaticSecret::from(*b"gosslan-fixture-x25519-A-eph-001");
    let eph_b_sec = StaticSecret::from(*b"gosslan-fixture-x25519-B-eph-001");
    let eph_a_pub = PublicKey::from(&eph_a_sec);
    let eph_b_pub = PublicKey::from(&eph_b_sec);
    let eph_a_pub_b64 = STANDARD.encode(eph_a_pub.as_bytes());
    let eph_b_pub_b64 = STANDARD.encode(eph_b_pub.as_bytes());

    let day = 20_454u64;
    let ch = channel_hash(&pk_a, &pk_b, id_a, id_b, day);
    let ch_hex = hex(&ch);
    // 对称性自检：换边算必须同值。
    assert_eq!(ch, channel_hash(&pk_b, &pk_a, id_b, id_a, day));

    let token = "gosslan-fixture-token";
    let hello_line = format!("GSRL1 {token} {ch_hex}\n");

    // 协商线 A / B。
    let role_a = wrap_role(id_a, id_b);
    let role_b = wrap_role(id_b, id_a);
    assert_eq!((role_a, role_b), ("A", "B"));
    let sb_a = wrap_signing_bytes(id_a, id_b, &ch_hex, role_a, &eph_a_pub_b64);
    let sb_b = wrap_signing_bytes(id_b, id_a, &ch_hex, role_b, &eph_b_pub_b64);
    let sig_a = STANDARD.encode(seed_a.sign(&sb_a).to_bytes());
    let sig_b = STANDARD.encode(seed_b.sign(&sb_b).to_bytes());
    let line_a = format!("{WRAP_MAGIC} {role_a} {eph_a_pub_b64} {sig_a}\n");
    let line_b = format!("{WRAP_MAGIC} {role_b} {eph_b_pub_b64} {sig_b}\n");

    // DH 与记录密钥（两侧必须同值，双向各验一次）。
    let dh_a = eph_a_sec.diffie_hellman(&eph_b_pub);
    let dh_b = eph_b_sec.diffie_hellman(&eph_a_pub);
    assert_eq!(dh_a.as_bytes(), dh_b.as_bytes());
    let (a2b, b2a) = record_keys(dh_a.as_bytes(), &ch_hex);

    // 记录层向量：内层帧 = 4B 大端长度 + JSON（与 transport/tcp.rs 一致）。
    let frame1 = b"{\"type\":\"heartbeat\"}";
    let mut inner1 = (frame1.len() as u32).to_be_bytes().to_vec();
    inner1.extend_from_slice(frame1);
    let rec1 = seal_frame(&a2b, 1, &inner1);
    let frame2 = b"{\"type\":\"chat\"}";
    let mut inner2 = (frame2.len() as u32).to_be_bytes().to_vec();
    inner2.extend_from_slice(frame2);
    let rec2 = seal_frame(&a2b, 2, &inner2);

    // epoch_day 向量（含负值钳零，与 relay.rs 测试同一组）。
    let d = 86_400_000i64;
    let epoch_vectors: Vec<(i64, u64)> = vec![
        (-5, 0),
        (0, 0),
        (d - 1, 0),
        (d, 1),
        (d * 2 + 12345, 2),
        (d * 20454, 20454),
    ];
    for (ms, want) in &epoch_vectors {
        assert_eq!(relay_epoch_day(*ms), *want);
    }

    let j = serde_json::json!({
        "meta": {
            "name": "gosslan-relay-wire-fixtures",
            "purpose": "中继线格式的共享真值向量：两个仓库的对照测试都必须复现这些字节，漂移即红。",
            "generated_from": {
                "repo": "gosslan (主仓)",
                "commit": "973b4df33428c2725aa27df5f63c23de81d75f7f",
                "source_files": [
                    "src-tauri/src/transport/relay_seal.rs",
                    "src-tauri/src/network/transport/relay.rs"
                ],
                "crate_versions": {
                    "serde_json": "1.0.151",
                    "sha2": "0.10.9",
                    "ed25519-dalek": "2.2.0",
                    "x25519-dalek": "2.0.1",
                    "chacha20poly1305": "0.10.1",
                    "base64": "0.22.1"
                }
            },
            "secrets_are_test_only": "本文件内的所有私钥/口令都是公开的测试值，不属于任何真实部署。"
        },
        "epoch_day": {
            "rule": "epoch_day = now_ms / 86_400_000（UTC 天序号）；now_ms < 0 时钳到 0",
            "vectors": epoch_vectors.iter().map(|(ms, day)| serde_json::json!({"now_ms": ms, "day": day})).collect::<Vec<_>>()
        },
        "hello_line": {
            "rule": "GSRL1 <token> <64 位小写十六进制通道哈希>\\n；整行 ≤ 256 字节；恰好 3 个字段",
            "token": token,
            "channel_hex": ch_hex,
            "line": hello_line,
            "negatives": [
                {"name": "uppercase-hex", "line": format!("GSRL1 {token} {}\n", ch_hex.to_uppercase()), "expect": "reject"},
                {"name": "short-hex", "line": format!("GSRL1 {token} deadbeef\n"), "expect": "reject"},
                {"name": "wrong-magic", "line": format!("GSRL2 {token} {ch_hex}\n"), "expect": "reject"},
                {"name": "wrong-token", "line": format!("GSRL1 not-the-token {ch_hex}\n"), "expect": "reject"},
                {"name": "extra-field", "line": format!("GSRL1 {token} {ch_hex} extra\n"), "expect": "reject"},
                {"name": "missing-field", "line": format!("GSRL1 {token}\n"), "expect": "reject"},
                {"name": "double-space", "line": format!("GSRL1 {token}  {ch_hex}\n"), "expect": "reject"},
                {"name": "no-newline-within-256", "line": format!("GSRL1 {token} {ch_hex}"), "expect": "hold-then-hello-timeout"}
            ]
        },
        "channel_hash": {
            "rule": "SHA-256(\"gosslan-relay-ch-v1\" ‖ id₁ ‖ 0x00 ‖ pk_b64₁ ‖ 0x00 ‖ id₂ ‖ 0x00 ‖ pk_b64₂ ‖ 0x00 ‖ epoch_day 大端 u64)；(id₁,pk₁)/(id₂,pk₂) 按 device_id ASCII 字典序",
            "inputs": {
                "device_id_a": id_a,
                "ed25519_pub_a_b64": pk_a,
                "device_id_b": id_b,
                "ed25519_pub_b_b64": pk_b,
                "epoch_day": day
            },
            "expected_hex": ch_hex
        },
        "wrap": {
            "rule": "GSRW1 <role A|B> <b64 临时 X25519> <b64 Ed25519 签名>\\n（4 字段，不带长期公钥）；签名材料 = serde_json 元组 (WRAP_PREFIX 字节, 我的 device_id, 期望对端 device_id, 通道哈希, role, 临时公钥 b64)",
            "ed25519": {
                "A": {"seed_b64": STANDARD.encode(seed_a.to_bytes()), "public_b64": pk_a},
                "B": {"seed_b64": STANDARD.encode(seed_b.to_bytes()), "public_b64": pk_b}
            },
            "x25519_ephemeral": {
                "A": {"secret_b64": STANDARD.encode(b"gosslan-fixture-x25519-A-eph-001"), "public_b64": eph_a_pub_b64},
                "B": {"secret_b64": STANDARD.encode(b"gosslan-fixture-x25519-B-eph-001"), "public_b64": eph_b_pub_b64}
            },
            "signing_bytes_hex": {"A": hex(&sb_a), "B": hex(&sb_b)},
            "offers": {
                "A": {"role": role_a, "eph_pub_b64": eph_a_pub_b64, "sig_b64": sig_a, "line": line_a},
                "B": {"role": role_b, "eph_pub_b64": eph_b_pub_b64, "sig_b64": sig_b, "line": line_b}
            },
            "dh_shared_secret_hex": hex(dh_a.as_bytes()),
            "record_keys": {"a2b_hex": hex(&a2b), "b2a_hex": hex(&b2a)}
        },
        "record": {
            "rule": "记录 = nonce(4B 零 ‖ 8B 大端计数器) ‖ ChaCha20Poly1305(计数器 ‖ 内层帧)；内层帧 = 4B 大端长度 ‖ JSON；密钥 = SHA-256(\"gosslan-relay-record-v1\" ‖ DH ‖ 通道哈希hex ‖ 0x00 ‖ \"a2b\"|\"b2a\")",
            "direction": "a2b",
            "key_hex": hex(&a2b),
            "vectors": [
                {"ctr": 1, "inner_json": "{\"type\":\"heartbeat\"}", "inner_frame_hex": hex(&inner1), "record_hex": hex(&rec1)},
                {"ctr": 2, "inner_json": "{\"type\":\"chat\"}", "inner_frame_hex": hex(&inner2), "record_hex": hex(&rec2)}
            ]
        }
    });
    println!("{}", serde_json::to_string_pretty(&j).unwrap());
}
