package bundle

type CompressionKind string

const (
	CompressionNone  CompressionKind = "none"
	CompressionLZMA  CompressionKind = "lzma"
	CompressionLZ4   CompressionKind = "lz4"
	CompressionLZ4HC CompressionKind = "lz4hc"
)

const ManifestName = "bundle_manifest.json"

type Node struct {
	ID       string `json:"id"`
	Path     string `json:"path"`
	Name     string `json:"name"`
	Offset   int64  `json:"offset"`
	Size     int64  `json:"size"`
	Flags    uint32 `json:"flags"`
	CRC      string `json:"crc,omitempty"`
	Changed  bool   `json:"changed"`
	FileName string `json:"file_name"`
	Kind     string `json:"kind"`
}

type Resource struct {
	ID          string `json:"id"`
	NodeID      string `json:"node_id"`
	NodePath    string `json:"node_path"`
	PathID      int64  `json:"path_id"`
	ClassID     int32  `json:"class_id"`
	Type        string `json:"type"`
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	Size        int64  `json:"size"`
	CRC         string `json:"crc,omitempty"`
	FileName    string `json:"file_name"`
	Details     string `json:"details,omitempty"`
	Replaceable bool   `json:"replaceable"`
	Changed     bool   `json:"changed"`
}

type Info struct {
	SourcePath        string          `json:"source_path"`
	Signature         string          `json:"signature"`
	FormatVersion     uint32          `json:"format_version"`
	PlayerVersion     string          `json:"player_version"`
	EngineVersion     string          `json:"engine_version"`
	TotalSize         uint64          `json:"total_size"`
	CompressedSize    uint32          `json:"compressed_size"`
	UncompressedSize  uint32          `json:"uncompressed_size"`
	Flags             uint32          `json:"flags"`
	Compression       CompressionKind `json:"compression"`
	BlocksInfoAtEnd   bool            `json:"blocks_info_at_end"`
	DirectoryAtEnd    bool            `json:"directory_at_end"`
	BlockCount        int             `json:"block_count"`
	NodeCount         int             `json:"node_count"`
	ResourceCount     int             `json:"resource_count"`
	Nodes             []Node          `json:"nodes"`
	UncompressedBytes int64           `json:"uncompressed_bytes"`
}

type Replacement struct {
	NodeID     string `json:"node_id"`
	NodePath   string `json:"node_path"`
	ResourceID string `json:"resource_id,omitempty"`
	SourcePath string `json:"source_path"`
	Size       int64  `json:"size"`
	CRC        string `json:"crc"`
	ReplacedAt string `json:"replaced_at"`
}

type Manifest struct {
	SchemaVersion int           `json:"schema_version"`
	Tool          string        `json:"tool"`
	SourceBundle  string        `json:"source_bundle"`
	ExtractedAt   string        `json:"extracted_at"`
	Info          Info          `json:"info"`
	Nodes         []Node        `json:"nodes"`
	Resources     []Resource    `json:"resources"`
	Replacements  []Replacement `json:"replacements"`
}
