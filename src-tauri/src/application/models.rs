use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Counts {
  pub dex: usize,
  pub native_libs: usize,
  pub res: usize,
  pub assets: usize,
  pub unity_bundles: usize,
  pub unity_addressable_bundles: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnityInfo {
  pub detected: bool,
  pub il2cpp: bool,
  pub addressables: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignatureInfo {
  pub v1_present: bool,
  pub apk_signing_block_present: bool,
  pub signature_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AddressablesInfo {
  pub version: String,
  pub build_target: String,
  pub settings_hash: String,
  pub catalog_count: usize,
  pub bundle_count: usize,
  pub bundle_samples: Vec<String>,
  pub resource_types: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanReport {
  pub apk: String,
  pub name: String,
  pub size_bytes: u64,
  pub entry_count: usize,
  pub counts: Counts,
  pub unity: UnityInfo,
  pub signature: SignatureInfo,
  pub addressables: AddressablesInfo,
  pub optional_tools: std::collections::BTreeMap<String, bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
  pub path: String,
  pub name: String,
  pub kind: String,
  pub size: u64,
  pub compressed: u64,
  pub crc: String,
  pub method: u16,
  pub modified: Vec<i32>,
  pub is_dir: bool,
  pub changed: bool,
  pub replaceable: bool,
  pub external_attr: u32,
  pub create_system: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Replacement {
  pub kind: Option<String>,
  pub path: String,
  pub source_path: String,
  pub size: u64,
  pub crc: String,
  pub replaced_at: String,
  pub node_id: Option<String>,
  pub node_path: Option<String>,
  pub resource_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
  pub schema_version: u32,
  pub tool: String,
  pub source_apk: String,
  pub source_size: u64,
  pub extracted_at: String,
  pub entries: Vec<Entry>,
  pub replacements: Vec<Replacement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildResult {
  pub output_apk: String,
  pub signed: bool,
  pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolStatus {
  pub tools: std::collections::BTreeMap<String, bool>,
  pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewResult {
  pub mode: String,
  pub title: String,
  pub text: Option<String>,
  pub summary: Option<String>,
  pub image_data_url: Option<String>,
  pub audio_data_url: Option<String>,
  pub file_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleNode {
  pub id: String,
  pub path: String,
  pub name: String,
  pub offset: i64,
  pub size: i64,
  pub flags: u32,
  pub crc: Option<String>,
  pub changed: bool,
  pub file_name: String,
  pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleResource {
  pub id: String,
  pub node_id: String,
  pub node_path: String,
  pub path_id: i64,
  pub class_id: i32,
  pub r#type: String,
  pub name: String,
  pub kind: String,
  pub size: i64,
  pub crc: Option<String>,
  pub file_name: String,
  pub details: Option<String>,
  pub replaceable: bool,
  pub changed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleInfo {
  pub source_path: String,
  pub signature: String,
  pub format_version: u32,
  pub player_version: String,
  pub engine_version: String,
  pub total_size: u64,
  pub compressed_size: u32,
  pub uncompressed_size: u32,
  pub flags: u32,
  pub compression: String,
  pub blocks_info_at_end: bool,
  pub directory_at_end: bool,
  pub block_count: usize,
  pub node_count: usize,
  pub resource_count: usize,
  pub nodes: Vec<BundleNode>,
  pub uncompressed_bytes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleManifest {
  pub schema_version: u32,
  pub tool: String,
  pub source_bundle: String,
  pub extracted_at: String,
  pub info: BundleInfo,
  pub nodes: Vec<BundleNode>,
  pub resources: Vec<BundleResource>,
  pub replacements: Vec<Replacement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectStateDto {
  pub scan: ScanReport,
  pub manifest: Option<Manifest>,
  pub work_dir: String,
  pub dist_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityLogItem {
  pub level: String,
  pub message: String,
  pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceGroup {
  pub id: String,
  pub label: String,
  pub count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleResourceSummary {
  pub bundle_path: String,
  pub bundle_name: String,
  pub resource: BundleResource,
  pub bundle_changed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BundleResourceCounts {
  pub all: usize,
  pub image: usize,
  pub text: usize,
  pub audio: usize,
  pub other: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkProgressEvent {
  pub kind: String,
  pub current: usize,
  pub total: usize,
  pub percent: f64,
  pub label: String,
  pub path: Option<String>,
  pub finished: bool,
}
