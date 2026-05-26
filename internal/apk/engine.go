package apk

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const ManifestName = "manifest.json"

var apkSigningBlockMagic = []byte("APK Sig Block 42")
var signatureSuffixes = []string{".SF", ".RSA", ".DSA", ".EC"}

func DefaultAPK() string {
	matches, _ := filepath.Glob(filepath.Join("apk", "*.apk"))
	if len(matches) == 0 {
		return ""
	}
	return matches[0]
}

func Scan(apkPath string) (ScanReport, error) {
	apkPath = filepath.Clean(apkPath)
	info, err := os.Stat(apkPath)
	if err != nil {
		return ScanReport{}, fmt.Errorf("APK 不存在: %w", err)
	}
	if info.IsDir() || strings.ToLower(filepath.Ext(apkPath)) != ".apk" {
		return ScanReport{}, fmt.Errorf("目标不是 APK 文件: %s", apkPath)
	}

	reader, err := zip.OpenReader(apkPath)
	if err != nil {
		return ScanReport{}, fmt.Errorf("不是有效 APK/ZIP: %w", err)
	}
	defer reader.Close()

	names := make([]string, 0, len(reader.File))
	var settings map[string]any
	var catalog map[string]any
	for _, file := range reader.File {
		names = append(names, file.Name)
		switch file.Name {
		case "assets/aa/settings.json":
			_ = readZipJSON(file, &settings)
		case "assets/aa/catalog.json":
			_ = readZipJSON(file, &catalog)
		}
	}

	return ScanReport{
		APK:           apkPath,
		Name:          filepath.Base(apkPath),
		SizeBytes:     info.Size(),
		EntryCount:    len(reader.File),
		Counts:        countNames(names),
		Unity:         detectUnity(names, settings != nil || catalog != nil),
		Signature:     detectSignature(apkPath, names),
		Addressables:  parseAddressables(settings, catalog),
		OptionalTools: ToolStatus(),
	}, nil
}

func Extract(apkPath string, workDir string, force bool) (Manifest, error) {
	apkPath = filepath.Clean(apkPath)
	workDir = filepath.Clean(workDir)
	info, err := os.Stat(apkPath)
	if err != nil {
		return Manifest{}, fmt.Errorf("APK 不存在: %w", err)
	}
	if stat, err := os.Stat(workDir); err == nil {
		if !stat.IsDir() {
			return Manifest{}, fmt.Errorf("输出路径不是目录: %s", workDir)
		}
		if force {
			if err := os.RemoveAll(workDir); err != nil {
				return Manifest{}, err
			}
		} else {
			empty, err := dirIsEmpty(workDir)
			if err != nil {
				return Manifest{}, err
			}
			if !empty {
				return Manifest{}, fmt.Errorf("工作区非空: %s", workDir)
			}
		}
	}
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		return Manifest{}, err
	}

	reader, err := zip.OpenReader(apkPath)
	if err != nil {
		return Manifest{}, fmt.Errorf("不是有效 APK/ZIP: %w", err)
	}
	defer reader.Close()

	entries := make([]Entry, 0, len(reader.File))
	for _, file := range reader.File {
		safePath, err := ValidateAPKPath(file.Name)
		if err != nil {
			return Manifest{}, err
		}
		entry := entryFromZip(file)
		entries = append(entries, entry)
		dest := filepath.Join(workDir, filepath.FromSlash(safePath))
		if file.FileInfo().IsDir() {
			if err := os.MkdirAll(dest, 0o755); err != nil {
				return Manifest{}, err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return Manifest{}, err
		}
		if err := extractZipFile(file, dest); err != nil {
			return Manifest{}, err
		}
	}

	manifest := Manifest{
		SchemaVersion: 1,
		Tool:          "apkworkshop",
		SourceAPK:     mustAbs(apkPath),
		SourceSize:    info.Size(),
		ExtractedAt:   time.Now().UTC().Format(time.RFC3339),
		Entries:       entries,
		Replacements:  []Replacement{},
	}
	if err := WriteManifest(workDir, manifest); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func LoadManifest(workDir string) (Manifest, error) {
	file, err := os.Open(filepath.Join(workDir, ManifestName))
	if err != nil {
		return Manifest{}, fmt.Errorf("未找到工作区清单: %w", err)
	}
	defer file.Close()
	var manifest Manifest
	if err := json.NewDecoder(file).Decode(&manifest); err != nil {
		return Manifest{}, fmt.Errorf("清单不是有效 JSON: %w", err)
	}
	changed := map[string]bool{}
	for _, item := range manifest.Replacements {
		changed[item.Path] = true
	}
	for i := range manifest.Entries {
		manifest.Entries[i].Changed = changed[manifest.Entries[i].Path]
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

func Replace(workDir string, targetPath string, sourcePath string) (Replacement, Manifest, error) {
	manifest, err := LoadManifest(workDir)
	if err != nil {
		return Replacement{}, Manifest{}, err
	}
	targetPath, err = ValidateAPKPath(targetPath)
	if err != nil {
		return Replacement{}, Manifest{}, err
	}
	if IsSignatureFile(targetPath) {
		return Replacement{}, Manifest{}, fmt.Errorf("不能替换旧签名文件: %s", targetPath)
	}
	index := -1
	for i, entry := range manifest.Entries {
		if entry.Path == targetPath {
			index = i
			break
		}
	}
	if index < 0 {
		return Replacement{}, Manifest{}, fmt.Errorf("清单中不存在路径: %s", targetPath)
	}
	if manifest.Entries[index].IsDir {
		return Replacement{}, Manifest{}, fmt.Errorf("不能替换目录: %s", targetPath)
	}
	if !manifest.Entries[index].Replaceable {
		return Replacement{}, Manifest{}, fmt.Errorf("该类型暂不支持替换: %s", targetPath)
	}
	if stat, err := os.Stat(sourcePath); err != nil || stat.IsDir() {
		return Replacement{}, Manifest{}, fmt.Errorf("替换文件不可用: %s", sourcePath)
	}
	dest := filepath.Join(workDir, filepath.FromSlash(targetPath))
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return Replacement{}, Manifest{}, err
	}
	if err := copyFile(sourcePath, dest); err != nil {
		return Replacement{}, Manifest{}, err
	}
	size, crc, err := fileCRC(dest)
	if err != nil {
		return Replacement{}, Manifest{}, err
	}
	manifest.Entries[index].Changed = true
	record := Replacement{
		Kind:       "apk-file",
		Path:       targetPath,
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

func MarkBundleNodeReplacement(workDir string, bundlePath string, nodeID string, nodePath string, sourcePath string, size int64, crc string) (Manifest, error) {
	manifest, err := LoadManifest(workDir)
	if err != nil {
		return Manifest{}, err
	}
	bundlePath, err = ValidateAPKPath(bundlePath)
	if err != nil {
		return Manifest{}, err
	}
	found := false
	for i := range manifest.Entries {
		if manifest.Entries[i].Path == bundlePath {
			if manifest.Entries[i].Kind != KindBundle {
				return Manifest{}, fmt.Errorf("目标不是 Bundle: %s", bundlePath)
			}
			manifest.Entries[i].Changed = true
			found = true
			break
		}
	}
	if !found {
		return Manifest{}, fmt.Errorf("清单中不存在 Bundle: %s", bundlePath)
	}
	record := Replacement{
		Kind:       "bundle-node",
		Path:       bundlePath,
		SourcePath: mustAbs(sourcePath),
		Size:       size,
		CRC:        crc,
		ReplacedAt: time.Now().UTC().Format(time.RFC3339),
		NodeID:     nodeID,
		NodePath:   nodePath,
	}
	manifest.Replacements = append(manifest.Replacements, record)
	if err := WriteManifest(workDir, manifest); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func Build(workDir string, outputAPK string) (BuildResult, error) {
	manifest, err := LoadManifest(workDir)
	if err != nil {
		return BuildResult{}, err
	}
	if err := os.MkdirAll(filepath.Dir(outputAPK), 0o755); err != nil {
		return BuildResult{}, err
	}
	tmp := outputAPK + ".tmp"
	_ = os.Remove(tmp)
	out, err := os.Create(tmp)
	if err != nil {
		return BuildResult{}, err
	}
	zipWriter := zip.NewWriter(out)
	for _, entry := range manifest.Entries {
		if IsSignatureFile(entry.Path) {
			continue
		}
		header := zip.FileHeader{
			Name:   entry.Path,
			Method: entry.Method,
		}
		if len(entry.Modified) >= 6 {
			header.SetModTime(time.Date(entry.Modified[0], time.Month(entry.Modified[1]), entry.Modified[2], entry.Modified[3], entry.Modified[4], entry.Modified[5], 0, time.Local))
		}
		if entry.IsDir {
			if !strings.HasSuffix(header.Name, "/") {
				header.Name += "/"
			}
			if _, err := zipWriter.CreateHeader(&header); err != nil {
				_ = zipWriter.Close()
				_ = out.Close()
				return BuildResult{}, err
			}
			continue
		}
		source := filepath.Join(workDir, filepath.FromSlash(entry.Path))
		if _, err := os.Stat(source); err != nil {
			_ = zipWriter.Close()
			_ = out.Close()
			return BuildResult{}, fmt.Errorf("构建失败，文件缺失: %s", entry.Path)
		}
		writer, err := zipWriter.CreateHeader(&header)
		if err != nil {
			_ = zipWriter.Close()
			_ = out.Close()
			return BuildResult{}, err
		}
		if err := copyFileToWriter(source, writer); err != nil {
			_ = zipWriter.Close()
			_ = out.Close()
			return BuildResult{}, err
		}
	}
	if err := zipWriter.Close(); err != nil {
		_ = out.Close()
		return BuildResult{}, err
	}
	if err := out.Close(); err != nil {
		return BuildResult{}, err
	}
	if err := os.Rename(tmp, outputAPK); err != nil {
		return BuildResult{}, err
	}
	return BuildResult{OutputAPK: outputAPK, Signed: false, Message: "已构建未签名 APK"}, nil
}

func SignDebug(unsignedAPK string, outputAPK string, keystore string) (BuildResult, error) {
	status := ToolStatus()
	for _, name := range []string{"keytool", "zipalign", "apksigner"} {
		if !status[name] {
			return BuildResult{}, fmt.Errorf("签名工具缺失: %s", name)
		}
	}
	if err := os.MkdirAll(filepath.Dir(keystore), 0o755); err != nil {
		return BuildResult{}, err
	}
	if _, err := os.Stat(keystore); err != nil {
		cmd := exec.Command("keytool", "-genkeypair", "-v", "-keystore", keystore, "-storepass", "android", "-keypass", "android", "-alias", "androiddebugkey", "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000", "-dname", "CN=Android Debug,O=Android,C=US")
		if output, err := cmd.CombinedOutput(); err != nil {
			return BuildResult{}, fmt.Errorf("生成调试证书失败: %s", strings.TrimSpace(string(output)))
		}
	}
	aligned := strings.TrimSuffix(outputAPK, ".apk") + "-aligned-tmp.apk"
	defer os.Remove(aligned)
	if output, err := exec.Command("zipalign", "-f", "-p", "4", unsignedAPK, aligned).CombinedOutput(); err != nil {
		return BuildResult{}, fmt.Errorf("zipalign 失败: %s", strings.TrimSpace(string(output)))
	}
	if output, err := exec.Command("apksigner", "sign", "--ks", keystore, "--ks-key-alias", "androiddebugkey", "--ks-pass", "pass:android", "--key-pass", "pass:android", "--out", outputAPK, aligned).CombinedOutput(); err != nil {
		return BuildResult{}, fmt.Errorf("apksigner 失败: %s", strings.TrimSpace(string(output)))
	}
	if output, err := exec.Command("apksigner", "verify", outputAPK).CombinedOutput(); err != nil {
		return BuildResult{}, fmt.Errorf("签名验证失败: %s", strings.TrimSpace(string(output)))
	}
	return BuildResult{OutputAPK: outputAPK, Signed: true, Message: "已构建并调试签名"}, nil
}

func ValidateAPKPath(name string) (string, error) {
	normalized := strings.ReplaceAll(name, "\\", "/")
	if normalized == "" || strings.HasPrefix(normalized, "/") || strings.HasPrefix(normalized, "../") {
		return "", fmt.Errorf("非法 APK 路径: %s", name)
	}
	for _, part := range strings.Split(normalized, "/") {
		if part == ".." {
			return "", fmt.Errorf("非法 APK 路径: %s", name)
		}
	}
	return normalized, nil
}

func IsSignatureFile(filename string) bool {
	upper := strings.ToUpper(filename)
	if upper == "META-INF/MANIFEST.MF" {
		return true
	}
	if !strings.HasPrefix(upper, "META-INF/") {
		return false
	}
	base := pathBase(upper)
	for _, suffix := range signatureSuffixes {
		if strings.HasSuffix(base, suffix) {
			return true
		}
	}
	return false
}

func ToolStatus() map[string]bool {
	tools := map[string]bool{}
	for _, name := range []string{"keytool", "zipalign", "apksigner", "apktool", "jadx"} {
		_, err := exec.LookPath(name)
		tools[name] = err == nil
	}
	return tools
}

func entryFromZip(file *zip.File) Entry {
	mod := file.Modified
	if mod.IsZero() {
		mod = time.Date(int(file.ModifiedDate>>9)+1980, time.Month((file.ModifiedDate>>5)&0xf), int(file.ModifiedDate&0x1f), int(file.ModifiedTime>>11), int((file.ModifiedTime>>5)&0x3f), int((file.ModifiedTime&0x1f)*2), 0, time.Local)
	}
	kind := Classify(file.Name)
	replaceable := !file.FileInfo().IsDir() && !IsSignatureFile(file.Name) && kind != KindDex && kind != KindNative
	return Entry{
		Path:         file.Name,
		Name:         pathBase(file.Name),
		Kind:         kind,
		Size:         int64(file.UncompressedSize64),
		Compressed:   int64(file.CompressedSize64),
		CRC:          fmt.Sprintf("%08x", file.CRC32),
		Method:       file.Method,
		Modified:     []int{mod.Year(), int(mod.Month()), mod.Day(), mod.Hour(), mod.Minute(), mod.Second()},
		IsDir:        file.FileInfo().IsDir(),
		Replaceable:  replaceable,
		ExternalAttr: file.ExternalAttrs,
		CreateSystem: file.CreatorVersion >> 8,
	}
}

func Classify(path string) EntryKind {
	lower := strings.ToLower(path)
	ext := strings.ToLower(filepath.Ext(lower))
	switch ext {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp":
		return KindImage
	case ".json", ".xml", ".txt", ".lua", ".properties", ".cfg", ".ini", ".md":
		return KindText
	case ".bundle":
		return KindBundle
	case ".dex":
		return KindDex
	case ".so":
		return KindNative
	case ".arsc":
		return KindAndroidResource
	default:
		return KindBinary
	}
}

func countNames(names []string) Counts {
	var counts Counts
	for _, name := range names {
		switch {
		case strings.HasSuffix(name, ".dex"):
			counts.Dex++
		case strings.HasPrefix(name, "lib/") && strings.HasSuffix(name, ".so"):
			counts.NativeLibs++
		case strings.HasPrefix(name, "res/"):
			counts.Res++
		case strings.HasPrefix(name, "assets/"):
			counts.Assets++
		}
		if strings.HasSuffix(name, ".bundle") {
			counts.UnityBundles++
			if strings.HasPrefix(name, "assets/aa/Android/") {
				counts.UnityAddressableBundles++
			}
		}
	}
	return counts
}

func detectUnity(names []string, addressables bool) UnityInfo {
	var info UnityInfo
	info.Addressables = addressables
	for _, name := range names {
		if name == "assets/bin/Data/data.unity3d" || name == "assets/bin/Data/Managed/Metadata/global-metadata.dat" || strings.HasSuffix(name, "libunity.so") {
			info.Detected = true
		}
		if strings.HasSuffix(name, "libil2cpp.so") {
			info.IL2CPP = true
		}
	}
	return info
}

func detectSignature(apkPath string, names []string) SignatureInfo {
	var info SignatureInfo
	for _, name := range names {
		if IsSignatureFile(name) {
			info.SignatureFiles = append(info.SignatureFiles, name)
		}
	}
	info.V1Present = len(info.SignatureFiles) > 0
	sort.Strings(info.SignatureFiles)
	info.APKSigningBlockPresent = hasAPKSigningBlock(apkPath)
	return info
}

func hasAPKSigningBlock(apkPath string) bool {
	file, err := os.Open(apkPath)
	if err != nil {
		return false
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil {
		return false
	}
	size := stat.Size()
	readSize := int64(65557)
	if size < readSize {
		readSize = size
	}
	tail := make([]byte, readSize)
	if _, err := file.ReadAt(tail, size-readSize); err != nil && !errors.Is(err, io.EOF) {
		return false
	}
	eocdIndex := bytes.LastIndex(tail, []byte{0x50, 0x4b, 0x05, 0x06})
	if eocdIndex < 0 || eocdIndex+22 > len(tail) {
		return false
	}
	centralDirOffset := int64(binary.LittleEndian.Uint32(tail[eocdIndex+16 : eocdIndex+20]))
	if centralDirOffset < 24 {
		return false
	}
	footer := make([]byte, 24)
	if _, err := file.ReadAt(footer, centralDirOffset-24); err != nil {
		return false
	}
	return bytes.Equal(footer[8:], apkSigningBlockMagic)
}

func parseAddressables(settings map[string]any, catalog map[string]any) AddressablesInfo {
	var info AddressablesInfo
	if settings != nil {
		info.Version, _ = settings["m_AddressablesVersion"].(string)
		info.BuildTarget, _ = settings["m_buildTarget"].(string)
		info.SettingsHash, _ = settings["m_SettingsHash"].(string)
		if locations, ok := settings["m_CatalogLocations"].([]any); ok {
			info.CatalogCount = len(locations)
		}
	}
	typeSet := map[string]bool{}
	if catalog != nil {
		if ids, ok := catalog["m_InternalIds"].([]any); ok {
			for _, raw := range ids {
				id, ok := raw.(string)
				if !ok || !strings.HasSuffix(id, ".bundle") {
					continue
				}
				info.BundleCount++
				if len(info.BundleSamples) < 10 {
					info.BundleSamples = append(info.BundleSamples, id)
				}
			}
		}
		if types, ok := catalog["m_resourceTypes"].([]any); ok {
			for _, raw := range types {
				item, ok := raw.(map[string]any)
				if !ok {
					continue
				}
				className, ok := item["m_ClassName"].(string)
				if ok && className != "" {
					typeSet[className] = true
				}
			}
		}
	}
	for item := range typeSet {
		info.ResourceTypes = append(info.ResourceTypes, item)
	}
	sort.Strings(info.ResourceTypes)
	return info
}

func readZipJSON(file *zip.File, target any) error {
	reader, err := file.Open()
	if err != nil {
		return err
	}
	defer reader.Close()
	return json.NewDecoder(reader).Decode(target)
}

func extractZipFile(file *zip.File, dest string) error {
	reader, err := file.Open()
	if err != nil {
		return err
	}
	defer reader.Close()
	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, reader)
	return err
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

func copyFileToWriter(src string, writer io.Writer) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	_, err = io.Copy(writer, in)
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

func pathBase(path string) string {
	idx := strings.LastIndex(path, "/")
	if idx >= 0 {
		return path[idx+1:]
	}
	return path
}

func mustAbs(path string) string {
	abs, err := filepath.Abs(path)
	if err != nil {
		return path
	}
	return abs
}
