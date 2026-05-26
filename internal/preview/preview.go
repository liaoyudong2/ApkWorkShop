package preview

import (
	"encoding/json"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"
	"strings"

	"apkworkshop/internal/apk"

	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/webp"
)

const maxTextBytes = 256 * 1024

type Result struct {
	Mode    string
	Title   string
	Text    string
	Image   image.Image
	Summary string
}

func Load(workDir string, entry apk.Entry, report apk.ScanReport) (Result, error) {
	fullPath := filepath.Join(workDir, filepath.FromSlash(entry.Path))
	switch entry.Kind {
	case apk.KindImage:
		return loadImage(fullPath, entry)
	case apk.KindText:
		return loadText(fullPath, entry)
	case apk.KindBundle:
		return bundleSummary(entry, report), nil
	default:
		return binarySummary(entry), nil
	}
}

func loadImage(path string, entry apk.Entry) (Result, error) {
	file, err := os.Open(path)
	if err != nil {
		return Result{}, err
	}
	defer file.Close()
	img, _, err := image.Decode(file)
	if err != nil {
		return Result{}, err
	}
	return Result{Mode: "image", Title: entry.Name, Image: img, Summary: fmt.Sprintf("%s\n%d bytes\nCRC %s", entry.Path, entry.Size, entry.CRC)}, nil
}

func loadText(path string, entry apk.Entry) (Result, error) {
	file, err := os.Open(path)
	if err != nil {
		return Result{}, err
	}
	defer file.Close()
	buf := make([]byte, maxTextBytes)
	n, _ := file.Read(buf)
	text := string(buf[:n])
	if strings.EqualFold(filepath.Ext(entry.Path), ".json") {
		var value any
		if err := json.Unmarshal(buf[:n], &value); err == nil {
			if pretty, err := json.MarshalIndent(value, "", "  "); err == nil {
				text = string(pretty)
			}
		}
	}
	if entry.Size > maxTextBytes {
		text += "\n\n... 内容过长，仅显示前 256KB ..."
	}
	return Result{Mode: "text", Title: entry.Name, Text: text}, nil
}

func bundleSummary(entry apk.Entry, report apk.ScanReport) Result {
	return Result{
		Mode:  "bundle",
		Title: entry.Name,
		Summary: fmt.Sprintf(
			"Unity Bundle\n路径: %s\n大小: %d bytes\nCRC: %s\nAddressables: %s\nBundle 总数: %d\n\n首版支持整 Bundle 文件替换，不编辑 Bundle 内对象。",
			entry.Path,
			entry.Size,
			entry.CRC,
			report.Addressables.Version,
			report.Counts.UnityBundles,
		),
	}
}

func binarySummary(entry apk.Entry) Result {
	return Result{
		Mode:    "binary",
		Title:   entry.Name,
		Summary: fmt.Sprintf("路径: %s\n类型: %s\n大小: %d bytes\nCRC: %s\n压缩方式: %d", entry.Path, entry.Kind, entry.Size, entry.CRC, entry.Method),
	}
}
