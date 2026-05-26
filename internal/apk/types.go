package apk

type EntryKind string

const (
	KindImage           EntryKind = "image"
	KindText            EntryKind = "text"
	KindBundle          EntryKind = "bundle"
	KindDex             EntryKind = "dex"
	KindNative          EntryKind = "native"
	KindAndroidResource EntryKind = "android-resource"
	KindBinary          EntryKind = "binary"
)

type Entry struct {
	Path         string    `json:"path"`
	Name         string    `json:"name"`
	Kind         EntryKind `json:"kind"`
	Size         int64     `json:"size"`
	Compressed   int64     `json:"compressed"`
	CRC          string    `json:"crc"`
	Method       uint16    `json:"method"`
	Modified     []int     `json:"modified"`
	IsDir        bool      `json:"is_dir"`
	Changed      bool      `json:"changed"`
	Replaceable  bool      `json:"replaceable"`
	ExternalAttr uint32    `json:"external_attr"`
	CreateSystem uint16    `json:"create_system"`
}

type Counts struct {
	Dex                     int `json:"dex"`
	NativeLibs              int `json:"native_libs"`
	Res                     int `json:"res"`
	Assets                  int `json:"assets"`
	UnityBundles            int `json:"unity_bundles"`
	UnityAddressableBundles int `json:"unity_addressable_bundles"`
}

type UnityInfo struct {
	Detected     bool `json:"detected"`
	IL2CPP       bool `json:"il2cpp"`
	Addressables bool `json:"addressables"`
}

type SignatureInfo struct {
	V1Present              bool     `json:"v1_present"`
	APKSigningBlockPresent bool     `json:"apk_signing_block_present"`
	SignatureFiles         []string `json:"signature_files"`
}

type AddressablesInfo struct {
	Version       string   `json:"version"`
	BuildTarget   string   `json:"build_target"`
	SettingsHash  string   `json:"settings_hash"`
	CatalogCount  int      `json:"catalog_count"`
	BundleCount   int      `json:"bundle_count"`
	BundleSamples []string `json:"bundle_samples"`
	ResourceTypes []string `json:"resource_types"`
}

type ScanReport struct {
	APK           string           `json:"apk"`
	Name          string           `json:"name"`
	SizeBytes     int64            `json:"size_bytes"`
	EntryCount    int              `json:"entry_count"`
	Counts        Counts           `json:"counts"`
	Unity         UnityInfo        `json:"unity"`
	Signature     SignatureInfo    `json:"signature"`
	Addressables  AddressablesInfo `json:"addressables"`
	OptionalTools map[string]bool  `json:"optional_tools"`
}

type Replacement struct {
	Kind       string `json:"kind,omitempty"`
	Path       string `json:"path"`
	SourcePath string `json:"source_path"`
	Size       int64  `json:"size"`
	CRC        string `json:"crc"`
	ReplacedAt string `json:"replaced_at"`
	NodeID     string `json:"node_id,omitempty"`
	NodePath   string `json:"node_path,omitempty"`
}

type Manifest struct {
	SchemaVersion int           `json:"schema_version"`
	Tool          string        `json:"tool"`
	SourceAPK     string        `json:"source_apk"`
	SourceSize    int64         `json:"source_size"`
	ExtractedAt   string        `json:"extracted_at"`
	Entries       []Entry       `json:"entries"`
	Replacements  []Replacement `json:"replacements"`
}

type BuildResult struct {
	OutputAPK string `json:"output_apk"`
	Signed    bool   `json:"signed"`
	Message   string `json:"message"`
}
