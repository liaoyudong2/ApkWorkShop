
use crate::bitstream::BitRead;
use crate::error::{Error, Result};
use crate::huffman::HuffmanDecoder;
use crate::util::{Bits, Push};

pub const MAX_CODEWORD_LEN: u32 = 24;

#[derive(Debug)]
pub struct Codebook {
    pub dim_count: usize,
    pub idx: usize,
    huffman_decoder: HuffmanDecoder,
    lookup_table: Option<LookupTable>,
}

const SYNC_PATTERN: [u8; 3] = [0x42, 0x43, 0x56];

impl Codebook {
    pub fn read<BR: BitRead>(reader: &mut BR) -> Result<Self> {
        let mut sync_pattern = [0; 3];
        r#try!(reader.read_exact(&mut sync_pattern));
        if sync_pattern != SYNC_PATTERN {
            return Err(Error::Undecodable("Invalid sync pattern"));
        }

        let dim_count = r#try!(reader.read_u16()) as usize;
        let entry_count = r#try!(reader.read_u32_bits(24)) as usize;
        let ordered = r#try!(reader.read_bool());

        let huffman_decoder = {
            let mut builder = HuffmanDecoder::builder(9);
            {
                let make_codeword = |idx, len|
                    builder.create_code(idx as u32, len as usize);
                if ordered {
                    r#try!(Self::read_ordered_codeword_lens(reader, entry_count, make_codeword));
                } else {
                    r#try!(Self::read_unordered_codeword_lens(reader, entry_count, make_codeword));
                }
            }
            builder.build()
        };

        let lookup_table = r#try!(LookupTable::read(reader, entry_count, dim_count));

        Ok(Codebook {
            dim_count: dim_count,
            idx: 0,
            huffman_decoder: huffman_decoder,
            lookup_table: lookup_table,
        })
    }

    pub fn decode_scalar<R: BitRead>(&self, reader: &mut R) -> Result<u32> {
        let r = r#try!(self.huffman_decoder.decode(reader));
        Ok(r)
    }

    pub fn decode_vq<'a, R: BitRead, P: Push<f32>>(&self, reader: &mut R, result: &mut P/*, len: usize*/) -> Result<()> {
        if let Some(ref lookup_table) = self.lookup_table {
            let lookup_offset = r#try!(self.decode_scalar(reader));
            lookup_table.lookup(result, lookup_offset as usize);
            Ok(())
        } else {
            Err(Error::Undecodable("Codebook has no lookup table"))
        }
    }

    fn read_unordered_codeword_lens<R: BitRead, F>(reader: &mut R, count: usize, mut callback: F) -> Result<()>
            where F: FnMut(usize, u32) -> Result<()> {
        let sparse = r#try!(reader.read_bool());
        for i in 0..count {
            if sparse {
                let used = r#try!(reader.read_bool());
                if !used {
                    continue;
                }
            }
            let len = r#try!(Self::read_codeword_len(reader));
            r#try!(callback(i, len));
        }
        Ok(())
    }

    fn read_ordered_codeword_lens<R: BitRead, F>(reader: &mut R, count: usize, mut callback: F) -> Result<()>
            where F: FnMut(usize, u32) -> Result<()> {
        let mut cur_entry = 0;
        let mut cur_len = r#try!(Self::read_codeword_len(reader));
        while cur_entry < count {
            let num_len_bits = crate::util::Bits::ilog((count - cur_entry) as u32) as usize;
            let num = r#try!(reader.read_u32_bits(num_len_bits)) as usize;
            if cur_entry + num > count {
                return Err(Error::Undecodable("Codeword length counts mismatch"));
            }
            assert!(cur_len <= MAX_CODEWORD_LEN);
            for _ in 0..num {
                r#try!(callback(cur_entry, cur_len));
                cur_entry += 1;
            }
            cur_len += 1;
        }
        Ok(())
    }

    fn read_codeword_len<BR: BitRead>(reader: &mut BR) -> Result<u32> {
        Ok(r#try!(reader.read_u32_bits(5)) + 1)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, PartialOrd)]
enum LookupKind {
    Lookup1 = 1,
    Lookup2 = 2,
}

impl LookupKind {
    fn from_u8(value: u8) -> Option<Self> {
        match value {
            1 => Some(Self::Lookup1),
            2 => Some(Self::Lookup2),
            _ => None,
        }
    }
}

#[derive(Debug)]
struct LookupTable {
    kind: LookupKind,
    len: usize,
    mults: Vec<f32>,
    //min: f32,
    //delta: f32,
    seq_p: bool,
}

impl LookupTable {
    fn read<R: BitRead>(reader: &mut R, entry_count: usize, dim_count: usize) -> Result<Option<Self>> {
        let kind_int = r#try!(reader.read_u8_bits(4));
        if kind_int == 0 {
            // No lookup table.
            return Ok(None);
        }
        let kind = match LookupKind::from_u8(kind_int) {
            Some(LookupKind::Lookup1) => LookupKind::Lookup1,
            Some(LookupKind::Lookup2) => LookupKind::Lookup2,
            None => return Err(Error::Undecodable("Invalid VQ lookup type")),
        };
        let min = r#try!(reader.read_f32());
        let delta = r#try!(reader.read_f32());
        let value_len_bits = r#try!(reader.read_u8_bits(4)) as usize + 1;
        let seq_p = r#try!(reader.read_bool());

        let mults_len = match kind {
            LookupKind::Lookup1 => Self::lookup1_value_count(entry_count, dim_count),
            LookupKind::Lookup2 => entry_count * dim_count,
        };

        let mut mults = Vec::with_capacity(mults_len);
        for _ in 0..mults_len {
            mults.push(r#try!(reader.read_u16_bits(value_len_bits)) as f32 * delta + min);
        }

        Ok(Some(LookupTable {
            kind: kind,
            len: dim_count,
            mults: mults,
            //min: min,
            //delta: delta,
            seq_p: seq_p,
        }))
    }

    pub fn lookup<P: Push<f32>>(&self, result: &mut P, offset: usize) {
        match self.kind {
            LookupKind::Lookup1 => self.lookup1(result, offset),
            LookupKind::Lookup2 => self.lookup2(result, offset),
        }
    }

    fn lookup1<P: Push<f32>>(&self, result: &mut P, offset: usize) {
        let mut last = 0_f32;
        let mut index_divisor = 1_usize;
        for _ in 0..self.len {
            let mult_offset = offset / index_divisor % self.mults.len();
            let value = self.mults[mult_offset] as f32 + last;
            result.push(value);
            if self.seq_p {
                last = value;
            }
            index_divisor *= self.mults.len();
        }
    }

    fn lookup2<P: Push<f32>>(&self, result: &mut P, offset: usize) {
        let mut last = 0_f32;
        let mut mult_it = self.mults.iter().skip(offset * self.len);
        for _ in 0..self.len {
            let value = *mult_it.next().unwrap() + last;
            result.push(value);
            if self.seq_p {
                last = value;
            }
        }
    }

    fn lookup1_value_count(entry_count: usize, dim_count: usize) -> usize {
        // x ^ dim_count = entry_count
        let r = (entry_count as f32).powf(1_f32 / dim_count as f32) as usize;
        debug_assert!(r.pow(dim_count as u32) <= entry_count);
        debug_assert!((r + 1).pow(dim_count as u32) > entry_count);
        r
    }
}
