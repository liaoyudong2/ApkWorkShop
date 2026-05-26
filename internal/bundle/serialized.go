package bundle

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"io"
	"path/filepath"
	"sort"
	"strings"

	"github.com/nigeltao/etc2/lib/etc2"
)

const (
	classTextAsset     int32 = 49
	classTexture2D     int32 = 28
	classAudioClip     int32 = 83
	classSprite        int32 = 213
	classMonoBehaviour int32 = 114
	classMonoScript    int32 = 115
	classShader        int32 = 48
	classMaterial      int32 = 21
	classGameObject    int32 = 1
	classMesh          int32 = 43
	classAnimator      int32 = 95
	classAnimation     int32 = 74
	classVideoClip     int32 = 329
	classFont          int32 = 128
)

type serializedObject struct {
	PathID        int64
	Offset        int64
	Size          int64
	Class         int32
	MetaOffsetPos int64
	MetaSizePos   int64
	MetaTypeIDPos int64
}

type serializedFile struct {
	BigEndian    bool
	Version      int32
	HeaderSize   int64
	MetadataSize int64
	DataOffset   int64
	Objects      []serializedObject
}

type texture2DInfo struct {
	Name          string
	Width         int
	Height        int
	Format        int32
	MipCount      int32
	IsReadable    bool
	DataSize      int
	Data          []byte
	StreamOffset  uint64
	StreamSize    uint32
	StreamPath    string
	HasStreamData bool
}

func extractSerializedResources(node Node, data []byte) []Resource {
	file, err := parseSerializedFile(data)
	if err != nil {
		return nil
	}
	resources := make([]Resource, 0)
	for index, object := range file.Objects {
		kind := kindForClass(object.Class)
		if kind == "binary" {
			continue
		}
		objectData := objectBytes(file, object, data)
		if len(objectData) == 0 {
			continue
		}
		name, payload := resourceNameAndPayload(object.Class, objectData, file.BigEndian)
		if name == "" {
			name = fmt.Sprintf("%s_%d", className(object.Class), object.PathID)
		}
		fileName := safeResourceFileName(index, name, kind, object.Class)
		details := ""
		if object.Class == classTextAsset {
			if len(payload) == 0 {
				payload = objectData
			}
		} else {
			payload = resourceMetadataWithPreview(object, name, objectData, file.BigEndian)
			details = string(payload)
			fileName = strings.TrimSuffix(fileName, filepath.Ext(fileName)) + ".meta.txt"
		}
		resources = append(resources, Resource{
			ID:          resourceID(node.ID, object.PathID),
			NodeID:      node.ID,
			NodePath:    node.Path,
			PathID:      object.PathID,
			ClassID:     object.Class,
			Type:        className(object.Class),
			Name:        name,
			Kind:        kind,
			Size:        int64(len(payload)),
			CRC:         crcHex(payload),
			FileName:    fileName,
			Details:     details,
			Replaceable: object.Class == classTextAsset,
		})
	}
	sort.SliceStable(resources, func(i, j int) bool {
		if resources[i].Kind == resources[j].Kind {
			return resources[i].Name < resources[j].Name
		}
		return resources[i].Kind < resources[j].Kind
	})
	return resources
}

func resourcePayload(resource Resource, nodeData []byte) []byte {
	file, err := parseSerializedFile(nodeData)
	if err != nil {
		return nil
	}
	for _, object := range file.Objects {
		if object.PathID != resource.PathID {
			continue
		}
		objectData := objectBytes(file, object, nodeData)
		if len(objectData) == 0 {
			return nil
		}
		_, payload := resourceNameAndPayload(object.Class, objectData, file.BigEndian)
		if len(payload) > 0 {
			return payload
		}
		return resourceMetadataWithPreview(object, resource.Name, objectData, file.BigEndian)
	}
	return nil
}

func resourcePreviewPNG(resource Resource, nodeData []byte, nodes []Node, bundlePayload []byte) ([]byte, string, error) {
	file, err := parseSerializedFile(nodeData)
	if err != nil {
		return nil, "", err
	}
	for _, object := range file.Objects {
		if object.PathID != resource.PathID {
			continue
		}
		info, err := parseTexture2D(objectBytes(file, object, nodeData), file.BigEndian)
		if err != nil {
			return nil, texture2DDetails(info), err
		}
		if len(info.Data) == 0 && info.HasStreamData {
			info.Data = findTextureStreamData(info, nodes, bundlePayload)
		}
		img, err := decodeTexture2D(info)
		if err != nil {
			return nil, texture2DDetails(info), err
		}
		out := bytes.NewBuffer(nil)
		if err := png.Encode(out, img); err != nil {
			return nil, texture2DDetails(info), err
		}
		return out.Bytes(), texture2DDetails(info), nil
	}
	return nil, "", fmt.Errorf("Texture2D 对象不存在: %s", resource.ID)
}

func replaceSerializedResource(nodeData []byte, resource Resource, replacement []byte) ([]byte, error) {
	if resource.ClassID != classTextAsset {
		return nil, fmt.Errorf("暂只支持替换 TextAsset 资源")
	}
	file, err := parseSerializedFile(nodeData)
	if err != nil {
		return nil, err
	}
	replaced := false
	objects := make([]serializedObject, len(file.Objects))
	copy(objects, file.Objects)
	objectData := map[int64][]byte{}
	for i, object := range objects {
		data := objectBytes(file, object, nodeData)
		if len(data) == 0 {
			return nil, fmt.Errorf("资源对象范围非法: %d", object.PathID)
		}
		if object.PathID == resource.PathID {
			next, err := replaceTextAssetPayload(data, file.BigEndian, replacement)
			if err != nil {
				return nil, err
			}
			data = next
			objects[i].Size = int64(len(next))
			replaced = true
		}
		objectData[object.PathID] = data
	}
	if !replaced {
		return nil, fmt.Errorf("资源对象不存在: %s", resource.ID)
	}
	prefix := make([]byte, file.DataOffset)
	copy(prefix, nodeData[:file.DataOffset])
	dataBuf := bytes.NewBuffer(nil)
	sorted := make([]serializedObject, len(objects))
	copy(sorted, objects)
	sort.SliceStable(sorted, func(i, j int) bool {
		return sorted[i].Offset < sorted[j].Offset
	})
	for _, object := range sorted {
		if padding := alignPadding(dataBuf.Len(), 8); padding > 0 {
			dataBuf.Write(make([]byte, padding))
		}
		newOffset := int64(dataBuf.Len())
		data := objectData[object.PathID]
		dataBuf.Write(data)
		for i := range objects {
			if objects[i].PathID == object.PathID {
				objects[i].Offset = newOffset
				objects[i].Size = int64(len(data))
				break
			}
		}
	}
	for _, object := range objects {
		writeAt(prefix, file.HeaderSize+object.MetaOffsetPos, uint64(object.Offset), 8, file.BigEndian)
		writeAt(prefix, file.HeaderSize+object.MetaSizePos, uint64(object.Size), 4, file.BigEndian)
	}
	output := append(prefix, dataBuf.Bytes()...)
	if file.Version >= 22 {
		binary.BigEndian.PutUint64(output[24:32], uint64(len(output)))
	} else {
		binary.BigEndian.PutUint32(output[4:8], uint32(len(output)))
	}
	return output, nil
}

func parseSerializedFile(data []byte) (serializedFile, error) {
	if len(data) < 32 {
		return serializedFile{}, fmt.Errorf("serialized file too short")
	}
	order := binary.BigEndian
	metadataSize := int64(order.Uint32(data[0:4]))
	fileSize := int64(order.Uint32(data[4:8]))
	version := int32(order.Uint32(data[8:12]))
	dataOffset := int64(order.Uint32(data[12:16]))
	endian := data[16]
	headerSize := int64(20)
	if version >= 22 {
		if len(data) < 48 {
			return serializedFile{}, fmt.Errorf("serialized file v22 header too short")
		}
		metadataSize = int64(order.Uint32(data[20:24]))
		fileSize = int64(order.Uint64(data[24:32]))
		dataOffset = int64(order.Uint64(data[32:40]))
		endian = data[40]
		headerSize = 48
	}
	if fileSize <= 0 || fileSize > int64(len(data))+4096 || dataOffset <= 0 || dataOffset > int64(len(data)) {
		return serializedFile{}, fmt.Errorf("invalid serialized header")
	}
	if metadataSize <= 0 || headerSize+metadataSize > int64(len(data)) {
		return serializedFile{}, fmt.Errorf("invalid metadata size")
	}
	bigEndian := endian != 0
	meta := bytes.NewReader(data[headerSize : headerSize+metadataSize])
	reader := endianReader{r: meta, big: bigEndian}
	if _, err := readString(meta); err != nil {
		return serializedFile{}, err
	}
	targetPlatform, err := reader.i32()
	if err != nil {
		return serializedFile{}, err
	}
	_ = targetPlatform
	hasTypeTrees := true
	if version >= 13 {
		v, err := reader.u8()
		if err != nil {
			return serializedFile{}, err
		}
		hasTypeTrees = v != 0
	}
	typeCount, err := reader.i32()
	if err != nil {
		return serializedFile{}, err
	}
	if typeCount < 0 || typeCount > 10000 {
		return serializedFile{}, fmt.Errorf("invalid type count")
	}
	typeClasses := make([]int32, typeCount)
	for i := int32(0); i < typeCount; i++ {
		classID, err := reader.i32()
		if err != nil {
			return serializedFile{}, err
		}
		typeClasses[i] = classID
		if version >= 16 {
			if _, err := reader.u8(); err != nil {
				return serializedFile{}, err
			}
		}
		if version >= 17 {
			if _, err := reader.i16(); err != nil {
				return serializedFile{}, err
			}
		}
		if version >= 16 {
			if classID == classMonoBehaviour {
				if _, err := readN(meta, 16); err != nil {
					return serializedFile{}, err
				}
			}
			if classID < 0 {
				if _, err := readN(meta, 16); err != nil {
					return serializedFile{}, err
				}
			}
		}
		if version >= 13 {
			if _, err := readN(meta, 16); err != nil {
				return serializedFile{}, err
			}
		}
		if hasTypeTrees {
			if err := skipTypeTree(meta, version); err != nil {
				return serializedFile{}, err
			}
			if version >= 21 {
				dependencyCount, err := reader.i32()
				if err != nil {
					return serializedFile{}, err
				}
				if dependencyCount < 0 || dependencyCount > 100000 {
					return serializedFile{}, fmt.Errorf("invalid type dependency count: %d", dependencyCount)
				}
				if _, err := readN(meta, int(dependencyCount)*4); err != nil {
					return serializedFile{}, err
				}
			}
		}
	}
	objectCount, err := reader.i32()
	if err != nil {
		return serializedFile{}, err
	}
	if objectCount < 0 || objectCount > 1000000 {
		return serializedFile{}, fmt.Errorf("invalid object count")
	}
	objects := make([]serializedObject, 0, objectCount)
	for i := int32(0); i < objectCount; i++ {
		var pathID int64
		if version >= 14 {
			alignReader(meta)
			pathID, err = reader.i64()
		} else {
			rawPathID, err := reader.i32()
			if err != nil {
				return serializedFile{}, err
			}
			pathID = int64(rawPathID)
		}
		if err != nil {
			return serializedFile{}, err
		}
		offsetPos := meta.Size() - int64(meta.Len())
		offset, err := reader.u64()
		if err != nil {
			return serializedFile{}, err
		}
		sizePos := meta.Size() - int64(meta.Len())
		size, err := reader.u32()
		if err != nil {
			return serializedFile{}, err
		}
		typeIDPos := meta.Size() - int64(meta.Len())
		typeID, err := reader.i32()
		if err != nil {
			return serializedFile{}, err
		}
		classID := typeID
		if typeID >= 0 && typeID < int32(len(typeClasses)) {
			classID = typeClasses[typeID]
		}
		objects = append(objects, serializedObject{
			PathID:        pathID,
			Offset:        int64(offset),
			Size:          int64(size),
			Class:         classID,
			MetaOffsetPos: offsetPos,
			MetaSizePos:   sizePos,
			MetaTypeIDPos: typeIDPos,
		})
		if version < 11 {
			if _, err := reader.i16(); err != nil {
				return serializedFile{}, err
			}
		}
		if version >= 11 && version < 17 {
			if _, err := reader.i16(); err != nil {
				return serializedFile{}, err
			}
		}
	}
	return serializedFile{BigEndian: bigEndian, Version: version, HeaderSize: headerSize, MetadataSize: metadataSize, DataOffset: dataOffset, Objects: objects}, nil
}

func objectBytes(file serializedFile, object serializedObject, data []byte) []byte {
	start := file.DataOffset + object.Offset
	end := start + object.Size
	if start < 0 || end < start || end > int64(len(data)) {
		return nil
	}
	return data[start:end]
}

func resourceNameAndPayload(classID int32, data []byte, bigEndian bool) (string, []byte) {
	reader := endianReader{r: bytes.NewReader(data), big: bigEndian}
	name, err := readAlignedString(reader.r, bigEndian)
	if err != nil {
		return "", nil
	}
	switch classID {
	case classTextAsset:
		size, err := reader.i32()
		if err != nil || size < 0 || size > int32(reader.r.Len()) {
			return name, nil
		}
		payload, err := readN(reader.r, int(size))
		if err != nil {
			return name, nil
		}
		return name, payload
	default:
		return name, nil
	}
}

func replaceTextAssetPayload(data []byte, bigEndian bool, replacement []byte) ([]byte, error) {
	reader := bytes.NewReader(data)
	if _, err := readAlignedString(reader, bigEndian); err != nil {
		return nil, err
	}
	sizePos := int(reader.Size() - int64(reader.Len()))
	er := endianReader{r: reader, big: bigEndian}
	oldSize, err := er.i32()
	if err != nil {
		return nil, err
	}
	if oldSize < 0 || oldSize > int32(reader.Len()) {
		return nil, fmt.Errorf("TextAsset 内容大小异常")
	}
	payloadStart := int(reader.Size() - int64(reader.Len()))
	payloadEnd := payloadStart + int(oldSize)
	alignedEnd := payloadEnd + alignPadding(payloadEnd, 4)
	if alignedEnd > len(data) {
		return nil, fmt.Errorf("TextAsset 内容范围异常")
	}
	out := bytes.NewBuffer(nil)
	out.Write(data[:sizePos])
	sizeBytes := make([]byte, 4)
	if bigEndian {
		binary.BigEndian.PutUint32(sizeBytes, uint32(len(replacement)))
	} else {
		binary.LittleEndian.PutUint32(sizeBytes, uint32(len(replacement)))
	}
	out.Write(sizeBytes)
	out.Write(replacement)
	if padding := alignPadding(out.Len(), 4); padding > 0 {
		out.Write(make([]byte, padding))
	}
	out.Write(data[alignedEnd:])
	return out.Bytes(), nil
}

func parseTexture2D(data []byte, bigEndian bool) (texture2DInfo, error) {
	reader := endianReader{r: bytes.NewReader(data), big: bigEndian}
	name, err := readAlignedString(reader.r, bigEndian)
	if err != nil {
		return texture2DInfo{}, err
	}
	for i := 0; i < 2; i++ {
		if _, err := reader.i32(); err != nil {
			return texture2DInfo{}, err
		}
	}
	width, err := reader.i32()
	if err != nil {
		return texture2DInfo{}, err
	}
	height, err := reader.i32()
	if err != nil {
		return texture2DInfo{}, err
	}
	completeSize, err := reader.i32()
	if err != nil {
		return texture2DInfo{}, err
	}
	_ = completeSize
	if _, err := reader.i32(); err != nil {
		return texture2DInfo{}, err
	}
	textureFormat, err := reader.i32()
	if err != nil {
		return texture2DInfo{}, err
	}
	mipCount, err := reader.i32()
	if err != nil {
		return texture2DInfo{}, err
	}
	readable, err := reader.i32()
	if err != nil {
		return texture2DInfo{}, err
	}
	for i := 0; i < 12; i++ {
		if _, err := reader.i32(); err != nil {
			return texture2DInfo{}, err
		}
	}
	dataSize, err := reader.i32()
	if err != nil {
		return texture2DInfo{}, err
	}
	if dataSize < 0 || int(dataSize) > reader.r.Len() {
		return texture2DInfo{}, fmt.Errorf("Texture2D 数据大小异常")
	}
	payload, err := readN(reader.r, int(dataSize))
	if err != nil {
		return texture2DInfo{}, err
	}
	alignReader(reader.r)
	info := texture2DInfo{
		Name:       name,
		Width:      int(width),
		Height:     int(height),
		Format:     textureFormat,
		MipCount:   mipCount,
		IsReadable: readable != 0,
		DataSize:   int(dataSize),
		Data:       payload,
	}
	if reader.r.Len() == 0 {
		return info, nil
	}
	streamOffset, err := reader.u64()
	if err != nil {
		return info, nil
	}
	streamSize, err := reader.u32()
	if err != nil {
		return info, nil
	}
	streamPath, err := readAlignedString(reader.r, bigEndian)
	if err != nil {
		return info, nil
	}
	info.StreamSize = streamSize
	info.StreamOffset = streamOffset
	info.StreamPath = streamPath
	info.HasStreamData = streamSize > 0 || streamPath != ""
	return info, nil
}

func decodeTexture2D(info texture2DInfo) (image.Image, error) {
	if info.Width <= 0 || info.Height <= 0 {
		return nil, fmt.Errorf("Texture2D 尺寸异常: %dx%d", info.Width, info.Height)
	}
	switch info.Format {
	case 3:
		return decodeRGB24(info)
	case 4:
		return decodeRGBA32(info)
	case 5:
		return decodeARGB32(info)
	case 47:
		return decodeETC2(info, etc2.FormatETC2RGBA8)
	default:
		return nil, fmt.Errorf("暂不支持 TextureFormat %d (%s)", info.Format, textureFormatName(info.Format))
	}
}

func decodeETC2(info texture2DInfo, format etc2.Format) (image.Image, error) {
	if len(info.Data) == 0 {
		return nil, fmt.Errorf("Texture2D 没有内嵌像素数据")
	}
	widthBlocks := (info.Width + 3) / 4
	heightBlocks := (info.Height + 3) / 4
	need := widthBlocks * heightBlocks * format.BytesPerBlock()
	if len(info.Data) < need {
		return nil, fmt.Errorf("Texture2D 数据不足: %d < %d", len(info.Data), need)
	}
	dst, err := format.NewImage(info.Width, info.Height)
	if err != nil {
		return nil, err
	}
	if err := format.Decode(dst, bytes.NewReader(info.Data[:need]), widthBlocks, heightBlocks); err != nil {
		return nil, err
	}
	return cropImage(dst, info.Width, info.Height), nil
}

func decodeRGB24(info texture2DInfo) (image.Image, error) {
	need := info.Width * info.Height * 3
	if len(info.Data) < need {
		return nil, fmt.Errorf("Texture2D 数据不足: %d < %d", len(info.Data), need)
	}
	img := image.NewNRGBA(image.Rect(0, 0, info.Width, info.Height))
	for i, p := 0, 0; i < need; i, p = i+3, p+4 {
		img.Pix[p+0] = info.Data[i+0]
		img.Pix[p+1] = info.Data[i+1]
		img.Pix[p+2] = info.Data[i+2]
		img.Pix[p+3] = 0xff
	}
	return img, nil
}

func decodeRGBA32(info texture2DInfo) (image.Image, error) {
	need := info.Width * info.Height * 4
	if len(info.Data) < need {
		return nil, fmt.Errorf("Texture2D 数据不足: %d < %d", len(info.Data), need)
	}
	img := image.NewNRGBA(image.Rect(0, 0, info.Width, info.Height))
	copy(img.Pix, info.Data[:need])
	return img, nil
}

func decodeARGB32(info texture2DInfo) (image.Image, error) {
	need := info.Width * info.Height * 4
	if len(info.Data) < need {
		return nil, fmt.Errorf("Texture2D 数据不足: %d < %d", len(info.Data), need)
	}
	img := image.NewNRGBA(image.Rect(0, 0, info.Width, info.Height))
	for i, p := 0, 0; i < need; i, p = i+4, p+4 {
		img.Pix[p+0] = info.Data[i+1]
		img.Pix[p+1] = info.Data[i+2]
		img.Pix[p+2] = info.Data[i+3]
		img.Pix[p+3] = info.Data[i+0]
	}
	return img, nil
}

func cropImage(src image.Image, width int, height int) image.Image {
	bounds := image.Rect(0, 0, width, height)
	dst := image.NewNRGBA(bounds)
	draw.Draw(dst, bounds, src, image.Point{}, draw.Src)
	return dst
}

func findTextureStreamData(info texture2DInfo, nodes []Node, payload []byte) []byte {
	if info.StreamSize == 0 {
		return nil
	}
	path := strings.TrimPrefix(info.StreamPath, "archive:/")
	if slash := strings.Index(path, "/"); slash >= 0 {
		path = path[slash+1:]
	}
	path = strings.TrimSpace(path)
	for _, node := range nodes {
		if path != "" && filepath.Base(node.Path) != filepath.Base(path) && node.Path != path {
			continue
		}
		start := node.Offset + int64(info.StreamOffset)
		end := start + int64(info.StreamSize)
		if start >= 0 && end >= start && end <= int64(len(payload)) {
			return payload[start:end]
		}
	}
	return nil
}

func texture2DDetails(info texture2DInfo) string {
	return fmt.Sprintf(
		"texture_width: %d\ntexture_height: %d\ntexture_format: %d (%s)\nmip_count: %d\nreadable: %t\nimage_data_size: %d\nstream_size: %d\nstream_offset: %d\nstream_path: %s",
		info.Width,
		info.Height,
		info.Format,
		textureFormatName(info.Format),
		info.MipCount,
		info.IsReadable,
		info.DataSize,
		info.StreamSize,
		info.StreamOffset,
		emptyString(info.StreamPath),
	)
}

func textureFormatName(format int32) string {
	switch format {
	case 3:
		return "RGB24"
	case 4:
		return "RGBA32"
	case 5:
		return "ARGB32"
	case 10:
		return "DXT1"
	case 12:
		return "DXT5"
	case 34:
		return "ETC_RGB4"
	case 45:
		return "ETC2_RGB"
	case 46:
		return "ETC2_RGBA1"
	case 47:
		return "ETC2_RGBA8"
	case 48:
		return "ASTC_RGB_4x4"
	case 49:
		return "ASTC_RGB_5x5"
	case 50:
		return "ASTC_RGB_6x6"
	case 51:
		return "ASTC_RGB_8x8"
	case 52:
		return "ASTC_RGB_10x10"
	case 53:
		return "ASTC_RGB_12x12"
	case 54:
		return "ASTC_RGBA_4x4"
	case 55:
		return "ASTC_RGBA_5x5"
	case 56:
		return "ASTC_RGBA_6x6"
	case 57:
		return "ASTC_RGBA_8x8"
	case 58:
		return "ASTC_RGBA_10x10"
	case 59:
		return "ASTC_RGBA_12x12"
	default:
		return "Unknown"
	}
}

func emptyString(value string) string {
	if value == "" {
		return "-"
	}
	return value
}

func skipTypeTree(reader *bytes.Reader, version int32) error {
	if version >= 12 || version == 10 {
		nodeCountBytes, err := readN(reader, 4)
		if err != nil {
			return err
		}
		stringBufferBytes, err := readN(reader, 4)
		if err != nil {
			return err
		}
		nodeCount := int(binary.LittleEndian.Uint32(nodeCountBytes))
		stringBufferSize := int(binary.LittleEndian.Uint32(stringBufferBytes))
		if nodeCount < 0 || nodeCount > 1000000 || stringBufferSize < 0 || stringBufferSize > 64*1024*1024 {
			return fmt.Errorf("invalid type tree: offset=%d nodes=%d string_buffer=%d remaining=%d", reader.Size()-int64(reader.Len())-8, nodeCount, stringBufferSize, reader.Len())
		}
		nodeSize := 24
		if version >= 19 {
			nodeSize = 32
		}
		need := nodeCount*nodeSize + stringBufferSize
		if need > reader.Len() {
			return fmt.Errorf("invalid type tree: offset=%d need=%d nodes=%d node_size=%d string_buffer=%d remaining=%d", reader.Size()-int64(reader.Len())-8, need, nodeCount, nodeSize, stringBufferSize, reader.Len())
		}
		_, err = readN(reader, need)
		return err
	}
	return skipOldTypeTree(reader)
}

func skipOldTypeTree(reader *bytes.Reader) error {
	if _, err := readString(reader); err != nil {
		return err
	}
	if _, err := readString(reader); err != nil {
		return err
	}
	if _, err := readN(reader, 20); err != nil {
		return err
	}
	childrenBytes, err := readN(reader, 4)
	if err != nil {
		return err
	}
	children := int(binary.LittleEndian.Uint32(childrenBytes))
	if children < 0 || children > 100000 {
		return fmt.Errorf("invalid old type tree")
	}
	for i := 0; i < children; i++ {
		if err := skipOldTypeTree(reader); err != nil {
			return err
		}
	}
	return nil
}

func readString(reader *bytes.Reader) (string, error) {
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
		if len(out) > 1024*1024 {
			return "", fmt.Errorf("string too long")
		}
	}
}

func readAlignedString(reader *bytes.Reader, bigEndian bool) (string, error) {
	er := endianReader{r: reader, big: bigEndian}
	size, err := er.i32()
	if err != nil {
		return "", err
	}
	if size < 0 || size > int32(reader.Len()) {
		return "", fmt.Errorf("invalid aligned string")
	}
	data, err := readN(reader, int(size))
	if err != nil {
		return "", err
	}
	alignReader(reader)
	return string(bytes.TrimRight(data, "\x00")), nil
}

func readN(reader *bytes.Reader, n int) ([]byte, error) {
	if n < 0 || n > reader.Len() {
		return nil, io.ErrUnexpectedEOF
	}
	out := make([]byte, n)
	_, err := io.ReadFull(reader, out)
	return out, err
}

func writeAt(data []byte, offset int64, value uint64, size int, bigEndian bool) {
	if offset < 0 || int(offset)+size > len(data) {
		return
	}
	target := data[offset : offset+int64(size)]
	switch size {
	case 4:
		if bigEndian {
			binary.BigEndian.PutUint32(target, uint32(value))
		} else {
			binary.LittleEndian.PutUint32(target, uint32(value))
		}
	case 8:
		if bigEndian {
			binary.BigEndian.PutUint64(target, value)
		} else {
			binary.LittleEndian.PutUint64(target, value)
		}
	}
}

func alignReader(reader *bytes.Reader) {
	padding := alignPadding(int(reader.Size()-int64(reader.Len())), 4)
	if padding > 0 && reader.Len() >= padding {
		_, _ = reader.Seek(int64(padding), io.SeekCurrent)
	}
}

type endianReader struct {
	r   *bytes.Reader
	big bool
}

func (e endianReader) order() binary.ByteOrder {
	if e.big {
		return binary.BigEndian
	}
	return binary.LittleEndian
}

func (e endianReader) u8() (uint8, error) {
	b, err := e.r.ReadByte()
	return b, err
}

func (e endianReader) i16() (int16, error) {
	data, err := readN(e.r, 2)
	if err != nil {
		return 0, err
	}
	return int16(e.order().Uint16(data)), nil
}

func (e endianReader) i32() (int32, error) {
	data, err := readN(e.r, 4)
	if err != nil {
		return 0, err
	}
	return int32(e.order().Uint32(data)), nil
}

func (e endianReader) u32() (uint32, error) {
	data, err := readN(e.r, 4)
	if err != nil {
		return 0, err
	}
	return e.order().Uint32(data), nil
}

func (e endianReader) i64() (int64, error) {
	data, err := readN(e.r, 8)
	if err != nil {
		return 0, err
	}
	return int64(e.order().Uint64(data)), nil
}

func (e endianReader) u64() (uint64, error) {
	data, err := readN(e.r, 8)
	if err != nil {
		return 0, err
	}
	return e.order().Uint64(data), nil
}

func resourceID(nodeID string, pathID int64) string {
	return nodeID + ":" + fmt.Sprintf("%d", pathID)
}

func safeResourceFileName(index int, name string, kind string, classID int32) string {
	clean := strings.TrimSpace(name)
	if clean == "" {
		clean = fmt.Sprintf("%s_%d", className(classID), index)
	}
	clean = strings.Map(func(r rune) rune {
		switch r {
		case '/', '\\', ':', '*', '?', '"', '<', '>', '|':
			return '_'
		default:
			return r
		}
	}, clean)
	ext := resourceExt(kind, classID)
	if filepath.Ext(clean) == "" {
		clean += ext
	}
	return fmt.Sprintf("%04d_%s", index, clean)
}

func resourceExt(kind string, classID int32) string {
	switch classID {
	case classTextAsset, classMonoScript:
		return ".txt"
	case classShader:
		return ".shader"
	default:
		if kind == "image" {
			return ".image.txt"
		}
		if kind == "audio" {
			return ".audio.txt"
		}
		return ".meta.txt"
	}
}

func kindForClass(classID int32) string {
	switch classID {
	case classTextAsset, classMonoScript, classShader:
		return "text"
	case classTexture2D, classSprite:
		return "image"
	case classAudioClip, classVideoClip:
		return "audio"
	default:
		return "binary"
	}
}

func className(classID int32) string {
	switch classID {
	case classGameObject:
		return "GameObject"
	case classMaterial:
		return "Material"
	case classTexture2D:
		return "Texture2D"
	case classShader:
		return "Shader"
	case classTextAsset:
		return "TextAsset"
	case classMesh:
		return "Mesh"
	case classAnimation:
		return "AnimationClip"
	case classAudioClip:
		return "AudioClip"
	case classAnimator:
		return "AnimatorController"
	case classMonoScript:
		return "MonoScript"
	case classFont:
		return "Font"
	case classSprite:
		return "Sprite"
	case classVideoClip:
		return "VideoClip"
	case classMonoBehaviour:
		return "MonoBehaviour"
	default:
		return fmt.Sprintf("Class%d", classID)
	}
}

func resourceMetadata(object serializedObject, name string) []byte {
	return resourceMetadataWithPreview(object, name, nil, false)
}

func resourceMetadataWithPreview(object serializedObject, name string, data []byte, bigEndian bool) []byte {
	preview := ""
	if len(data) > 0 {
		limit := len(data)
		if limit > 64 {
			limit = 64
		}
		preview = hex.EncodeToString(data[:limit])
	}
	extra := ""
	if object.Class == classTexture2D {
		if info, err := parseTexture2D(data, bigEndian); err == nil {
			extra = "\n" + texture2DDetails(info)
		}
	}
	return []byte(fmt.Sprintf(
		"name: %s\ntype: %s\nclass_id: %d\npath_id: %d\nobject_size: %d%s\nraw_preview: %s\n",
		name,
		className(object.Class),
		object.Class,
		object.PathID,
		object.Size,
		extra,
		preview,
	))
}
