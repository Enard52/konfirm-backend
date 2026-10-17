use stellar_strkey::ed25519::MuxedAccount;

/// Decodes the muxed ID that self-identifies which Link (or standing
/// address) a payment belongs to. Horizon reports the *base* account in a
/// payment operation's `to` field and exposes the muxed form separately as
/// `to_muxed` / `to_muxed_id` — reading only `to` silently finds nothing,
/// which is the exact bug that made the original reconciler match zero
/// payments. Always prefer the explicit id, then decode the M-address, and
/// only fall back to `to` (which carries no muxed component at all) last.
pub fn payment_muxed_id(to_muxed_id: Option<&str>, to_muxed: Option<&str>, to: &str) -> Option<u64> {
    if let Some(id_str) = to_muxed_id {
        if let Ok(id) = id_str.parse::<u64>() {
            return Some(id);
        }
    }
    if let Some(m_address) = to_muxed {
        if let Some(id) = decode_muxed_id(m_address) {
            return Some(id);
        }
    }
    decode_muxed_id(to)
}

fn decode_muxed_id(address: &str) -> Option<u64> {
    MuxedAccount::from_string(address).ok().map(|m| m.id)
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn round_trips_a_known_muxed_id() {
        let muxed = MuxedAccount { ed25519: [7u8; 32], id: 424_242 };
        let encoded = muxed.to_string();
        assert_eq!(decode_muxed_id(&encoded), Some(424_242));
    }

    #[test]
    fn round_trips_boundary_muxed_ids() {
        for id in [0u64, u64::MAX] {
            let muxed = MuxedAccount { ed25519: [3u8; 32], id };
            let encoded = muxed.to_string();
            assert_eq!(decode_muxed_id(&encoded), Some(id));
            assert_eq!(payment_muxed_id(None, Some(encoded.as_str()), "GARBAGE"), Some(id));
        }
        assert_eq!(payment_muxed_id(Some("18446744073709551615"), None, "GARBAGE"), Some(u64::MAX));
    }

    #[test]
    fn prefers_explicit_to_muxed_id_field() {
        let muxed = MuxedAccount { ed25519: [1u8; 32], id: 99 };
        let encoded = muxed.to_string();
        // Even if to_muxed disagreed, the explicit field wins — it's the
        // field Horizon actually populates first for this reason.
        let id = payment_muxed_id(Some("99"), Some(encoded.as_str()), "GARBAGE");
        assert_eq!(id, Some(99));
    }

    #[test]
    fn falls_back_to_decoding_to_muxed_when_id_field_absent() {
        let muxed = MuxedAccount { ed25519: [2u8; 32], id: 55 };
        let encoded = muxed.to_string();
        let id = payment_muxed_id(None, Some(encoded.as_str()), "GARBAGE");
        assert_eq!(id, Some(55));
    }

    #[test]
    fn plain_g_address_has_no_muxed_id() {
        // A base G-address decodes as ed25519::PublicKey, not MuxedAccount —
        // reading only `to` (as the original bug did) finds nothing, which
        // is exactly why this function must not stop there.
        let plain = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
        assert_eq!(payment_muxed_id(None, None, plain), None);
    }
}
