use crate::bitstream::BitRead;
use crate::error::{Error, Result};
use crate::header::FrameKind;

#[derive(Debug)]
pub struct Mode {
    pub frame_kind: FrameKind,
    pub mapping: usize,
}

impl Mode {
    pub fn read<R: BitRead>(reader: &mut R, mapping_count: usize) -> Result<Self> {
        let frame_kind = if r#try!(reader.read_bool()) {
            FrameKind::Long
        } else {
            FrameKind::Short
        };
        if r#try!(reader.read_u16()) != 0 {
            return Err(Error::Undecodable("Invalid mode window type"));
        }
        if r#try!(reader.read_u16()) != 0 {
            return Err(Error::Undecodable("Invalid mode transform type"));
        }
        let mapping = r#try!(reader.read_u8()) as usize;
        if mapping >= mapping_count {
            return Err(Error::Undecodable("Invalid mode mapping"));
        }

        Ok(Mode {
            frame_kind: frame_kind,
            mapping: mapping,
        })
    }
}