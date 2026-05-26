package bundle

import (
	"bytes"
	"crypto/sha1"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/pierrec/lz4/v4"
)

const (
	unitySignature      = "UnityFS"
	blockInfoAtEndFlag  = 0x80
	directoryAtEndFlag  = 0x100
	compressionMask     = 0x3f
	maxBundleHeaderRead = 1024 * 1024
)

type blockInfo struct {
	UncompressedSize uint32
	CompressedSize   uint32
	Flags            uint16
}

type parsedBundle struct {
	Info       Info
	Header     []byte
	Blocks     []blockInfo
	Nodes      []Node
	Payload    []byte
	RawPayload []byte
}

func Analyze(bundlePath string) (Info, error) {
	parsed, err := parse(bundlePath, false)
	if err != nil {
		return Info{}, err
	}
	return parsed.Info, nil
}

func Extract(bundlePath string, outDir string, force bool) (Manifest, error) {
	parsed, err := parse(bundlePath, true)
	if err != nil {
		return Manifest{}, err
	}
	if stat, err := os.Stat(outDir); err == nil {
		if !stat.IsDir() {
			return Manifest{}, fmt.Errorf("Bundle 工作区不是目录: %s", outDir)
		}
		if force {
			if err := os.RemoveAll(outDir); err != nil {
				return Manifest{}, err
			}
		} else if empty, err := dirIsEmpty(outDir); err != nil {
			return Manifest{}, err
		} else if !empty {
			return Manifest{}, fmt.Errorf("Bundle 工作区非空: %s", outDir)
		}
	}
	filesDir := filepath.Join(outDir, "files")
	resourcesDir := filepath.Join(outDir, "resources")
	if err := os.MkdirAll(filesDir, 0o755); err != nil {
		return Manifest{}, err
	}
	if err := os.MkdirAll(resourcesDir, 0o755); err != nil {
		return Manifest{}, err
	}

	nodes := make([]Node, len(parsed.Nodes))
	copy(nodes, parsed.Nodes)
	resources := make([]Resource, 0)
	for i := range nodes {
		node := &nodes[i]
		start := int(node.Offset)
		end := start + int(node.Size)
		if start < 0 || end < start || end > len(parsed.Payload) {
			return Manifest{}, fmt.Errorf("Bundle 节点范围非法: %s", node.Path)
		}
		node.FileName = safeNodeFileName(i, node.Path)
		node.Kind = classifyNode(node.Path)
		node.CRC = crcHex(parsed.Payload[start:end])
		dest := filepath.Join(filesDir, node.FileName)
		if err := os.WriteFile(dest, parsed.Payload[start:end], 0o644); err != nil {
			return Manifest{}, err
		}
		nodeResources := extractSerializedResources(*node, parsed.Payload[start:end])
		for j := range nodeResources {
			resource := &nodeResources[j]
			data := resourcePayload(*resource, parsed.Payload[start:end])
			if len(data) == 0 {
				data = []byte(fmt.Sprintf("name: %s\ntype: %s\nclass_id: %d\npath_id: %d\n", resource.Name, resource.Type, resource.ClassID, resource.PathID))
			}
			if resource.ClassID == classTexture2D {
				if pngData, details, err := resourcePreviewPNG(*resource, parsed.Payload[start:end], nodes, parsed.Payload); err == nil {
					data = pngData
					resource.FileName = strings.TrimSuffix(resource.FileName, filepath.Ext(resource.FileName)) + ".png"
					resource.Details = details
				} else if details != "" {
					resource.Details = details + "\npreview_error: " + err.Error()
					data = []byte(resource.Details)
				}
			}
			resource.Size = int64(len(data))
			resource.CRC = crcHex(data)
			if err := os.WriteFile(filepath.Join(resourcesDir, resource.FileName), data, 0o644); err != nil {
				return Manifest{}, err
			}
			resources = append(resources, *resource)
		}
	}

	parsed.Info.ResourceCount = len(resources)
	manifest := Manifest{
		SchemaVersion: 1,
		Tool:          "apkworkshop",
		SourceBundle:  mustAbs(bundlePath),
		ExtractedAt:   time.Now().UTC().Format(time.RFC3339),
		Info:          parsed.Info,
		Nodes:         nodes,
		Resources:     resources,
		Replacements:  []Replacement{},
	}
	if err := WriteManifest(outDir, manifest); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func LoadManifest(workDir string) (Manifest, error) {
	file, err := os.Open(filepath.Join(workDir, ManifestName))
	if err != nil {
		return Manifest{}, fmt.Errorf("未找到 Bundle 清单: %w", err)
	}
	defer file.Close()
	var manifest Manifest
	if err := json.NewDecoder(file).Decode(&manifest); err != nil {
		return Manifest{}, fmt.Errorf("Bundle 清单不是有效 JSON: %w", err)
	}
	changed := map[string]bool{}
	for _, item := range manifest.Replacements {
		changed[item.NodeID] = true
	}
	for i := range manifest.Nodes {
		manifest.Nodes[i].Changed = changed[manifest.Nodes[i].ID]
		if manifest.Nodes[i].FileName == "" {
			manifest.Nodes[i].FileName = safeNodeFileName(i, manifest.Nodes[i].Path)
		}
		if manifest.Nodes[i].Kind == "" {
			manifest.Nodes[i].Kind = classifyNode(manifest.Nodes[i].Path)
		}
	}
	return manifest, nil
}

func WriteManifest(workDir string, manifest Manifest) error {
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(filepath.Join(workDir, ManifestName), data, 0o644)
}

func ReplaceNode(workDir string, nodeID string, sourcePath string) (Replacement, Manifest, error) {
	manifest, err := LoadManifest(workDir)
	if err != nil {
		return Replacement{}, Manifest{}, err
	}
	index := -1
	for i, node := range manifest.Nodes {
		if node.ID == nodeID {
			index = i
			break
		}
	}
	if index < 0 {
		return Replacement{}, Manifest{}, fmt.Errorf("Bundle 节点不存在: %s", nodeID)
	}
	stat, err := os.Stat(sourcePath)
	if err != nil || stat.IsDir() {
		return Replacement{}, Manifest{}, fmt.Errorf("替换文件不可用: %s", sourcePath)
	}
	dest := filepath.Join(workDir, "files", manifest.Nodes[index].FileName)
	if err := copyFile(sourcePath, dest); err != nil {
		return Replacement{}, Manifest{}, err
	}
	size, crc, err := fileCRC(dest)
	if err != nil {
		return Replacement{}, Manifest{}, err
	}
	manifest.Nodes[index].Changed = true
	manifest.Nodes[index].Size = size
	manifest.Nodes[index].CRC = crc
	record := Replacement{
		NodeID:     nodeID,
		NodePath:   manifest.Nodes[index].Path,
		SourcePath: mustAbs(sourcePath),
		Size:       size,
		CRC:        crc,
		ReplacedAt: time.Now().UTC().Format(time.RFC3339),
	}
	manifest.Replacements = append(manifest.Replacements, record)
	if err := WriteManifest(workDir, manifest); err != nil {
		return Replacement{}, Manifest{}, err
	}
	return record, manifest, nil
}

func ReplaceResource(workDir string, resourceID string, sourcePath string) (Replacement, Manifest, error) {
	manifest, err := LoadManifest(workDir)
	if err != nil {
		return Replacement{}, Manifest{}, err
	}
	index := -1
	for i, resource := range manifest.Resources {
		if resource.ID == resourceID {
			index = i
			break
		}
	}
	if index < 0 {
		return Replacement{}, Manifest{}, fmt.Errorf("Bundle 资源不存在: %s", resourceID)
	}
	resource := manifest.Resources[index]
	if !resource.Replaceable {
		return Replacement{}, Manifest{}, fmt.Errorf("该资源暂不支持内容替换: %s", resource.Type)
	}
	replacement, err := os.ReadFile(sourcePath)
	if err != nil {
		return Replacement{}, Manifest{}, fmt.Errorf("替换文件不可用: %s", sourcePath)
	}
	nodeIndex := -1
	for i, node := range manifest.Nodes {
		if node.ID == resource.NodeID {
			nodeIndex = i
			break
		}
	}
	if nodeIndex < 0 {
		return Replacement{}, Manifest{}, fmt.Errorf("资源所在节点不存在: %s", resource.NodeID)
	}
	nodePath := filepath.Join(workDir, "files", manifest.Nodes[nodeIndex].FileName)
	nodeData, err := os.ReadFile(nodePath)
	if err != nil {
		return Replacement{}, Manifest{}, err
	}
	nextNodeData, err := replaceSerializedResource(nodeData, resource, replacement)
	if err != nil {
		return Replacement{}, Manifest{}, err
	}
	if err := os.WriteFile(nodePath, nextNodeData, 0o644); err != nil {
		return Replacement{}, Manifest{}, err
	}
	resourceDest := filepath.Join(workDir, "resources", resource.FileName)
	if err := os.WriteFile(resourceDest, replacement, 0o644); err != nil {
		return Replacement{}, Manifest{}, err
	}
	size, crc, err := fileCRC(resourceDest)
	if err != nil {
		return Replacement{}, Manifest{}, err
	}
	manifest.Resources[index].Changed = true
	manifest.Resources[index].Size = size
	manifest.Resources[index].CRC = crc
	manifest.Nodes[nodeIndex].Changed = true
	manifest.Nodes[nodeIndex].Size = int64(len(nextNodeData))
	manifest.Nodes[nodeIndex].CRC = crcHex(nextNodeData)
	record := Replacement{
		NodeID:     resource.NodeID,
		NodePath:   resource.NodePath,
		ResourceID: resource.ID,
		SourcePath: mustAbs(sourcePath),
		Size:       size,
		CRC:        crc,
		ReplacedAt: time.Now().UTC().Format(time.RFC3339),
	}
	manifest.Replacements = append(manifest.Replacements, record)
	if err := WriteManifest(workDir, manifest); err != nil {
		return Replacement{}, Manifest{}, err
	}
	return record, manifest, nil
}

func Build(workDir string, outputBundlePath string) error {
	manifest, err := LoadManifest(workDir)
	if err != nil {
		return err
	}
	if len(manifest.Nodes) == 0 {
		return fmt.Errorf("Bundle 清单没有节点")
	}
	payload := bytes.NewBuffer(nil)
	nodes := make([]Node, len(manifest.Nodes))
	copy(nodes, manifest.Nodes)
	for i := range nodes {
		node := &nodes[i]
		source := filepath.Join(workDir, "files", node.FileName)
		data, err := os.ReadFile(source)
		if err != nil {
			return fmt.Errorf("Bundle 节点文件缺失: %s", node.Path)
		}
		node.Offset = int64(payload.Len())
		node.Size = int64(len(data))
		node.CRC = crcHex(data)
		if _, err := payload.Write(data); err != nil {
			return err
		}
	}

	compression := manifest.Info.Compression
	if compression == CompressionLZMA {
		return fmt.Errorf("不支持重封 LZMA Bundle")
	}
	block := blockInfo{UncompressedSize: uint32(payload.Len()), Flags: compressionFlag(compression)}
	compressedPayload, err := compressBlock(payload.Bytes(), compression)
	if err != nil {
		return err
	}
	block.CompressedSize = uint32(len(compressedPayload))

	blocksInfo, err := encodeBlocksInfo([]blockInfo{block}, nodes)
	if err != nil {
		return err
	}
	compressedBlocksInfo, err := compressBlock(blocksInfo, compression)
	if err != nil {
		return err
	}

	headerInfo := manifest.Info
	headerInfo.CompressedSize = uint32(len(compressedBlocksInfo))
	headerInfo.UncompressedSize = uint32(len(blocksInfo))
	headerInfo.Flags = (headerInfo.Flags &^ compressionMask) | uint32(compressionFlag(compression))
	headerInfo.Flags &^= blockInfoAtEndFlag | directoryAtEndFlag
	headerInfo.TotalSize = uint64(headerSize(headerInfo) + len(compressedBlocksInfo) + len(compressedPayload))

	if err := os.MkdirAll(filepath.Dir(outputBundlePath), 0o755); err != nil {
		return err
	}
	tmp := outputBundlePath + ".tmp"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if err := writeHeader(out, headerInfo); err != nil {
		_ = out.Close()
		return err
	}
	if _, err := out.Write(compressedBlocksInfo); err != nil {
		_ = out.Close()
		return err
	}
	if _, err := out.Write(compressedPayload); err != nil {
		_ = out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, outputBundlePath)
}

func parse(bundlePath string, withPayload bool) (parsedBundle, error) {
	data, err := os.ReadFile(bundlePath)
	if err != nil {
		return parsedBundle{}, err
	}
	reader := bytes.NewReader(data)
	info, header, err := readHeader(reader)
	if err != nil {
		return parsedBundle{}, err
	}
	info.SourcePath = mustAbs(bundlePath)
	if info.Signature != unitySignature {
		return parsedBundle{}, fmt.Errorf("不支持的 Bundle 格式: %s", info.Signature)
	}
	if info.FormatVersion != 6 && info.FormatVersion != 7 {
		return parsedBundle{}, fmt.Errorf("不支持的 UnityFS 版本: %d", info.FormatVersion)
	}
	if info.DirectoryAtEnd {
		return parsedBundle{}, fmt.Errorf("暂不支持目录信息位于文件末尾的 Bundle")
	}
	if info.Compression == CompressionLZMA {
		return parsedBundle{}, fmt.Errorf("暂不支持 LZMA Bundle")
	}

	var compressedBlocksInfo []byte
	if info.BlocksInfoAtEnd {
		start := int64(len(data)) - int64(info.CompressedSize)
		if start < 0 {
			return parsedBundle{}, fmt.Errorf("Bundle blocks info 范围非法")
		}
		compressedBlocksInfo = data[start:]
	} else {
		if int64(len(data))-reader.Size()+reader.Size() < 0 {
			return parsedBundle{}, fmt.Errorf("Bundle 读取状态异常")
		}
		if int64(len(data))-int64(reader.Len())+int64(info.CompressedSize) > int64(len(data)) {
			return parsedBundle{}, fmt.Errorf("Bundle blocks info 超出文件范围")
		}
		compressedBlocksInfo = make([]byte, info.CompressedSize)
		if _, err := io.ReadFull(reader, compressedBlocksInfo); err != nil {
			return parsedBundle{}, err
		}
	}
	blocksInfo, err := decompressBlock(compressedBlocksInfo, info.UncompressedSize, info.Compression)
	if err != nil {
		return parsedBundle{}, fmt.Errorf("解压 blocks info 失败: %w", err)
	}
	blocks, nodes, err := decodeBlocksInfo(blocksInfo)
	if err != nil {
		return parsedBundle{}, err
	}
	info.BlockCount = len(blocks)
	info.NodeCount = len(nodes)
	info.Nodes = nodes

	out := parsedBundle{Info: info, Header: header, Blocks: blocks, Nodes: nodes}
	if !withPayload {
		return out, nil
	}
	rawPayload := make([]byte, 0)
	if info.BlocksInfoAtEnd {
		payloadStart := len(header)
		payloadEnd := int64(len(data)) - int64(info.CompressedSize)
		if payloadEnd < int64(payloadStart) {
			return parsedBundle{}, fmt.Errorf("Bundle payload 范围非法")
		}
		rawPayload = data[payloadStart:payloadEnd]
	} else {
		rawPayload, err = io.ReadAll(reader)
		if err != nil {
			return parsedBundle{}, err
		}
	}
	payload := bytes.NewBuffer(nil)
	offset := 0
	for _, block := range blocks {
		end := offset + int(block.CompressedSize)
		if end > len(rawPayload) {
			return parsedBundle{}, fmt.Errorf("Bundle block 超出 payload 范围")
		}
		chunk, err := decompressBlock(rawPayload[offset:end], block.UncompressedSize, compressionFromFlags(uint32(block.Flags)))
		if err != nil {
			return parsedBundle{}, fmt.Errorf("解压 Bundle block 失败: %w", err)
		}
		if _, err := payload.Write(chunk); err != nil {
			return parsedBundle{}, err
		}
		offset = end
	}
	out.Payload = payload.Bytes()
	out.RawPayload = rawPayload
	out.Info.UncompressedBytes = int64(len(out.Payload))
	return out, nil
}

func readHeader(reader *bytes.Reader) (Info, []byte, error) {
	startLen := reader.Len()
	signature, err := readCString(reader)
	if err != nil {
		return Info{}, nil, err
	}
	version, err := readU32(reader)
	if err != nil {
		return Info{}, nil, err
	}
	player, err := readCString(reader)
	if err != nil {
		return Info{}, nil, err
	}
	engine, err := readCString(reader)
	if err != nil {
		return Info{}, nil, err
	}
	total, err := readU64(reader)
	if err != nil {
		return Info{}, nil, err
	}
	compressed, err := readU32(reader)
	if err != nil {
		return Info{}, nil, err
	}
	uncompressed, err := readU32(reader)
	if err != nil {
		return Info{}, nil, err
	}
	flags, err := readU32(reader)
	if err != nil {
		return Info{}, nil, err
	}
	if version >= 7 {
		consumed := startLen - reader.Len()
		padding := alignPadding(consumed, 16)
		if padding > 0 {
			if reader.Len() < padding {
				return Info{}, nil, fmt.Errorf("Bundle header 对齐填充不足")
			}
			if _, err := reader.Seek(int64(padding), io.SeekCurrent); err != nil {
				return Info{}, nil, err
			}
		}
	}
	headerSize := startLen - reader.Len()
	if headerSize <= 0 || headerSize > maxBundleHeaderRead {
		return Info{}, nil, fmt.Errorf("Bundle header 大小异常")
	}
	header := make([]byte, headerSize)
	if _, err := reader.ReadAt(header, 0); err != nil {
		return Info{}, nil, err
	}
	info := Info{
		Signature:        signature,
		FormatVersion:    version,
		PlayerVersion:    player,
		EngineVersion:    engine,
		TotalSize:        total,
		CompressedSize:   compressed,
		UncompressedSize: uncompressed,
		Flags:            flags,
		Compression:      compressionFromFlags(flags),
		BlocksInfoAtEnd:  flags&blockInfoAtEndFlag != 0,
		DirectoryAtEnd:   flags&directoryAtEndFlag != 0,
	}
	return info, header, nil
}

func decodeBlocksInfo(data []byte) ([]blockInfo, []Node, error) {
	reader := bytes.NewReader(data)
	if reader.Len() < 16 {
		return nil, nil, fmt.Errorf("blocks info 太短")
	}
	hash := make([]byte, 16)
	if _, err := io.ReadFull(reader, hash); err != nil {
		return nil, nil, err
	}
	blockCount, err := readI32(reader)
	if err != nil {
		return nil, nil, err
	}
	if blockCount < 0 || blockCount > 100000 {
		return nil, nil, fmt.Errorf("block 数量异常: %d", blockCount)
	}
	blocks := make([]blockInfo, blockCount)
	for i := range blocks {
		uncompressed, err := readU32(reader)
		if err != nil {
			return nil, nil, err
		}
		compressed, err := readU32(reader)
		if err != nil {
			return nil, nil, err
		}
		flags, err := readU16(reader)
		if err != nil {
			return nil, nil, err
		}
		blocks[i] = blockInfo{UncompressedSize: uncompressed, CompressedSize: compressed, Flags: flags}
	}
	nodeCount, err := readI32(reader)
	if err != nil {
		return nil, nil, err
	}
	if nodeCount < 0 || nodeCount > 100000 {
		return nil, nil, fmt.Errorf("节点数量异常: %d", nodeCount)
	}
	nodes := make([]Node, nodeCount)
	for i := range nodes {
		offset, err := readI64(reader)
		if err != nil {
			return nil, nil, err
		}
		size, err := readI64(reader)
		if err != nil {
			return nil, nil, err
		}
		flags, err := readU32(reader)
		if err != nil {
			return nil, nil, err
		}
		path, err := readCString(reader)
		if err != nil {
			return nil, nil, err
		}
		nodes[i] = Node{
			ID:     nodeID(i, path),
			Path:   path,
			Name:   filepath.Base(path),
			Offset: offset,
			Size:   size,
			Flags:  flags,
			Kind:   classifyNode(path),
		}
	}
	return blocks, nodes, nil
}

func encodeBlocksInfo(blocks []blockInfo, nodes []Node) ([]byte, error) {
	buf := bytes.NewBuffer(nil)
	buf.Write(make([]byte, 16))
	if err := writeI32(buf, int32(len(blocks))); err != nil {
		return nil, err
	}
	for _, block := range blocks {
		if err := writeU32(buf, block.UncompressedSize); err != nil {
			return nil, err
		}
		if err := writeU32(buf, block.CompressedSize); err != nil {
			return nil, err
		}
		if err := writeU16(buf, block.Flags); err != nil {
			return nil, err
		}
	}
	if err := writeI32(buf, int32(len(nodes))); err != nil {
		return nil, err
	}
	sort.SliceStable(nodes, func(i, j int) bool {
		return nodes[i].Offset < nodes[j].Offset
	})
	for _, node := range nodes {
		if err := writeI64(buf, node.Offset); err != nil {
			return nil, err
		}
		if err := writeI64(buf, node.Size); err != nil {
			return nil, err
		}
		if err := writeU32(buf, node.Flags); err != nil {
			return nil, err
		}
		if err := writeCString(buf, node.Path); err != nil {
			return nil, err
		}
	}
	return buf.Bytes(), nil
}

func writeHeader(writer io.Writer, info Info) error {
	buf := bytes.NewBuffer(nil)
	if err := writeCString(buf, unitySignature); err != nil {
		return err
	}
	if err := writeU32(buf, info.FormatVersion); err != nil {
		return err
	}
	if err := writeCString(buf, info.PlayerVersion); err != nil {
		return err
	}
	if err := writeCString(buf, info.EngineVersion); err != nil {
		return err
	}
	if err := writeU64(buf, info.TotalSize); err != nil {
		return err
	}
	if err := writeU32(buf, info.CompressedSize); err != nil {
		return err
	}
	if err := writeU32(buf, info.UncompressedSize); err != nil {
		return err
	}
	if err := writeU32(buf, info.Flags); err != nil {
		return err
	}
	if info.FormatVersion >= 7 {
		buf.Write(make([]byte, alignPadding(buf.Len(), 16)))
	}
	_, err := writer.Write(buf.Bytes())
	return err
}

func headerSize(info Info) int {
	size := len(unitySignature) + 1 +
		4 +
		len(info.PlayerVersion) + 1 +
		len(info.EngineVersion) + 1 +
		8 + 4 + 4 + 4
	if info.FormatVersion >= 7 {
		size += alignPadding(size, 16)
	}
	return size
}

func decompressBlock(src []byte, size uint32, compression CompressionKind) ([]byte, error) {
	switch compression {
	case CompressionNone:
		if uint32(len(src)) != size {
			return nil, fmt.Errorf("未压缩块大小不匹配: %d != %d", len(src), size)
		}
		out := make([]byte, len(src))
		copy(out, src)
		return out, nil
	case CompressionLZ4, CompressionLZ4HC:
		out := make([]byte, size)
		n, err := lz4.UncompressBlock(src, out)
		if err != nil {
			return nil, err
		}
		if n != int(size) {
			return nil, fmt.Errorf("LZ4 解压大小不匹配: %d != %d", n, size)
		}
		return out, nil
	case CompressionLZMA:
		return nil, fmt.Errorf("暂不支持 LZMA")
	default:
		return nil, fmt.Errorf("未知压缩方式: %s", compression)
	}
}

func compressBlock(src []byte, compression CompressionKind) ([]byte, error) {
	switch compression {
	case CompressionNone:
		out := make([]byte, len(src))
		copy(out, src)
		return out, nil
	case CompressionLZ4:
		out := make([]byte, lz4.CompressBlockBound(len(src)))
		var compressor lz4.Compressor
		n, err := compressor.CompressBlock(src, out)
		if err != nil {
			return nil, err
		}
		if n == 0 {
			return compressBlock(src, CompressionNone)
		}
		return out[:n], nil
	case CompressionLZ4HC:
		out := make([]byte, lz4.CompressBlockBound(len(src)))
		compressor := lz4.CompressorHC{Level: 9}
		n, err := compressor.CompressBlock(src, out)
		if err != nil {
			return nil, err
		}
		if n == 0 {
			return compressBlock(src, CompressionNone)
		}
		return out[:n], nil
	case CompressionLZMA:
		return nil, fmt.Errorf("暂不支持 LZMA")
	default:
		return nil, fmt.Errorf("未知压缩方式: %s", compression)
	}
}

func compressionFromFlags(flags uint32) CompressionKind {
	switch flags & compressionMask {
	case 0:
		return CompressionNone
	case 1:
		return CompressionLZMA
	case 2:
		return CompressionLZ4
	case 3:
		return CompressionLZ4HC
	default:
		return CompressionKind(fmt.Sprintf("unknown-%d", flags&compressionMask))
	}
}

func compressionFlag(kind CompressionKind) uint16 {
	switch kind {
	case CompressionNone:
		return 0
	case CompressionLZMA:
		return 1
	case CompressionLZ4:
		return 2
	case CompressionLZ4HC:
		return 3
	default:
		return 0
	}
}

func alignPadding(size int, align int) int {
	if align <= 0 {
		return 0
	}
	remainder := size % align
	if remainder == 0 {
		return 0
	}
	return align - remainder
}

func nodeID(index int, path string) string {
	sum := sha1.Sum([]byte(fmt.Sprintf("%d:%s", index, path)))
	return hex.EncodeToString(sum[:8])
}

func safeNodeFileName(index int, path string) string {
	name := filepath.Base(strings.ReplaceAll(path, "\\", "/"))
	if name == "." || name == "/" || name == "" {
		name = "node"
	}
	name = strings.Map(func(r rune) rune {
		switch r {
		case '/', '\\', ':', '*', '?', '"', '<', '>', '|':
			return '_'
		default:
			return r
		}
	}, name)
	return fmt.Sprintf("%04d_%s", index, name)
}

func classifyNode(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp":
		return "image"
	case ".json", ".xml", ".txt", ".lua", ".properties", ".cfg", ".ini", ".md", ".shader":
		return "text"
	default:
		return "binary"
	}
}

func readCString(reader *bytes.Reader) (string, error) {
	var out []byte
	for {
		b, err := reader.ReadByte()
		if err != nil {
			return "", err
		}
		if b == 0 {
			return string(out), nil
		}
		out = append(out, b)
		if len(out) > maxBundleHeaderRead {
			return "", fmt.Errorf("字符串字段过长")
		}
	}
}

func writeCString(writer io.Writer, value string) error {
	if _, err := writer.Write([]byte(value)); err != nil {
		return err
	}
	_, err := writer.Write([]byte{0})
	return err
}

func readU16(reader io.Reader) (uint16, error) {
	var value uint16
	err := binary.Read(reader, binary.BigEndian, &value)
	return value, err
}

func readU32(reader io.Reader) (uint32, error) {
	var value uint32
	err := binary.Read(reader, binary.BigEndian, &value)
	return value, err
}

func readU64(reader io.Reader) (uint64, error) {
	var value uint64
	err := binary.Read(reader, binary.BigEndian, &value)
	return value, err
}

func readI32(reader io.Reader) (int32, error) {
	var value int32
	err := binary.Read(reader, binary.BigEndian, &value)
	return value, err
}

func readI64(reader io.Reader) (int64, error) {
	var value int64
	err := binary.Read(reader, binary.BigEndian, &value)
	return value, err
}

func writeU16(writer io.Writer, value uint16) error {
	return binary.Write(writer, binary.BigEndian, value)
}

func writeU32(writer io.Writer, value uint32) error {
	return binary.Write(writer, binary.BigEndian, value)
}

func writeU64(writer io.Writer, value uint64) error {
	return binary.Write(writer, binary.BigEndian, value)
}

func writeI32(writer io.Writer, value int32) error {
	return binary.Write(writer, binary.BigEndian, value)
}

func writeI64(writer io.Writer, value int64) error {
	return binary.Write(writer, binary.BigEndian, value)
}

func dirIsEmpty(path string) (bool, error) {
	file, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer file.Close()
	_, err = file.Readdirnames(1)
	if errors.Is(err, io.EOF) {
		return true, nil
	}
	return false, err
}

func copyFile(src string, dest string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func fileCRC(path string) (int64, string, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, "", err
	}
	defer file.Close()
	hash := crc32.NewIEEE()
	size, err := io.Copy(hash, file)
	if err != nil {
		return 0, "", err
	}
	return size, fmt.Sprintf("%08x", hash.Sum32()), nil
}

func crcHex(data []byte) string {
	return fmt.Sprintf("%08x", crc32.ChecksumIEEE(data))
}

func mustAbs(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		return path
	}
	return abs
}
