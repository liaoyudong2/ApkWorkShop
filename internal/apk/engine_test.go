package apk

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"

	"apkworkshop/internal/bundle"
)

func TestScanSampleAPK(t *testing.T) {
	path := sampleAPK(t)
	report, err := Scan(path)
	if err != nil {
		t.Fatal(err)
	}
	if report.EntryCount != 820 {
		t.Fatalf("entry count = %d, want 820", report.EntryCount)
	}
	if report.Counts.UnityBundles != 719 {
		t.Fatalf("bundle count = %d, want 719", report.Counts.UnityBundles)
	}
	if report.Addressables.Version != "1.21.2" {
		t.Fatalf("addressables = %q", report.Addressables.Version)
	}
}

func TestExtractReplaceBuild(t *testing.T) {
	tmp := t.TempDir()
	sourceAPK := filepath.Join(tmp, "sample.apk")
	makeTinyAPK(t, sourceAPK)
	workDir := filepath.Join(tmp, "work")
	if _, err := Extract(sourceAPK, workDir, false); err != nil {
		t.Fatal(err)
	}
	newFile := filepath.Join(tmp, "new.png")
	if err := os.WriteFile(newFile, []byte("new image"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Replace(workDir, "assets/foo.png", newFile); err != nil {
		t.Fatal(err)
	}
	outAPK := filepath.Join(tmp, "out.apk")
	if _, err := Build(workDir, outAPK); err != nil {
		t.Fatal(err)
	}
	reader, err := zip.OpenReader(outAPK)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	names := map[string]bool{}
	var replacedHash [32]byte
	for _, file := range reader.File {
		names[file.Name] = true
		if file.Name == "assets/foo.png" {
			rc, err := file.Open()
			if err != nil {
				t.Fatal(err)
			}
			data, err := io.ReadAll(rc)
			_ = rc.Close()
			if err != nil {
				t.Fatal(err)
			}
			replacedHash = sha256.Sum256(data)
		}
	}
	expected, _ := os.ReadFile(newFile)
	expectedHash := sha256.Sum256(expected)
	if replacedHash != expectedHash {
		t.Fatal("replacement content mismatch")
	}
	for _, sig := range []string{"META-INF/MANIFEST.MF", "META-INF/CERT.SF", "META-INF/CERT.RSA"} {
		if names[sig] {
			t.Fatalf("signature file %s should be removed", sig)
		}
	}
}

func TestBundleNodeReplacementBuildAPK(t *testing.T) {
	sourceAPK := sampleAPK(t)
	tmp := t.TempDir()
	workDir := filepath.Join(tmp, "work")
	if _, err := Extract(sourceAPK, workDir, false); err != nil {
		t.Fatal(err)
	}
	manifest, err := LoadManifest(workDir)
	if err != nil {
		t.Fatal(err)
	}
	var bundlePath string
	for _, entry := range manifest.Entries {
		if entry.Kind == KindBundle {
			bundlePath = entry.Path
			break
		}
	}
	if bundlePath == "" {
		t.Fatal("bundle not found")
	}
	bundleWork := filepath.Join(tmp, "bundle-work")
	bundleManifest, err := bundle.Extract(filepath.Join(workDir, filepath.FromSlash(bundlePath)), bundleWork, false)
	if err != nil {
		t.Fatal(err)
	}
	node := bundleManifest.Nodes[0]
	replacement := filepath.Join(tmp, "bundle-node.bin")
	if err := os.WriteFile(replacement, []byte("apk integrated bundle node"), 0o644); err != nil {
		t.Fatal(err)
	}
	record, _, err := bundle.ReplaceNode(bundleWork, node.ID, replacement)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := MarkBundleNodeReplacement(workDir, bundlePath, record.NodeID, record.NodePath, record.SourcePath, record.Size, record.CRC); err != nil {
		t.Fatal(err)
	}
	if err := bundle.Build(bundleWork, filepath.Join(workDir, filepath.FromSlash(bundlePath))); err != nil {
		t.Fatal(err)
	}
	outAPK := filepath.Join(tmp, "out.apk")
	if _, err := Build(workDir, outAPK); err != nil {
		t.Fatal(err)
	}
	reader, err := zip.OpenReader(outAPK)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	var rebuiltBundle []byte
	for _, file := range reader.File {
		if file.Name != bundlePath {
			continue
		}
		rc, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		rebuiltBundle, err = io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(rebuiltBundle) == 0 {
		t.Fatal("rebuilt bundle not found in apk")
	}
	bundleOut := filepath.Join(tmp, "from-apk.bundle")
	if err := os.WriteFile(bundleOut, rebuiltBundle, 0o644); err != nil {
		t.Fatal(err)
	}
	verifyDir := filepath.Join(tmp, "verify-bundle")
	verifyManifest, err := bundle.Extract(bundleOut, verifyDir, false)
	if err != nil {
		t.Fatal(err)
	}
	var verifyNode bundle.Node
	for _, item := range verifyManifest.Nodes {
		if item.ID == node.ID {
			verifyNode = item
			break
		}
	}
	if verifyNode.ID == "" {
		t.Fatal("replaced node missing")
	}
	data, err := os.ReadFile(filepath.Join(verifyDir, "files", verifyNode.FileName))
	if err != nil {
		t.Fatal(err)
	}
	want, _ := os.ReadFile(replacement)
	if sha256.Sum256(data) != sha256.Sum256(want) {
		t.Fatal("bundle node replacement not written into apk")
	}
}

func sampleAPK(t *testing.T) string {
	t.Helper()
	matches, _ := filepath.Glob(filepath.Join("..", "..", "apk", "*.apk"))
	if len(matches) == 0 {
		t.Skip("sample APK not found")
	}
	return matches[0]
}

func makeTinyAPK(t *testing.T, path string) {
	t.Helper()
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	settings := map[string]any{"m_buildTarget": "Android", "m_AddressablesVersion": "1.21.2", "m_CatalogLocations": []any{}}
	catalog := map[string]any{
		"m_InternalIds":   []any{"{UnityEngine.AddressableAssets.Addressables.RuntimePath}/Android/a.bundle"},
		"m_resourceTypes": []any{map[string]any{"m_ClassName": "UnityEngine.Texture2D"}},
	}
	writeZip(t, writer, "classes.dex", []byte("dex"))
	writeZip(t, writer, "lib/arm64-v8a/libunity.so", []byte("unity"))
	writeZip(t, writer, "assets/aa/settings.json", mustJSON(t, settings))
	writeZip(t, writer, "assets/aa/catalog.json", mustJSON(t, catalog))
	writeZip(t, writer, "assets/aa/Android/a.bundle", []byte("bundle"))
	writeZip(t, writer, "assets/foo.png", []byte("old image"))
	writeZip(t, writer, "META-INF/MANIFEST.MF", []byte("manifest"))
	writeZip(t, writer, "META-INF/CERT.SF", []byte("sf"))
	writeZip(t, writer, "META-INF/CERT.RSA", []byte("rsa"))
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func writeZip(t *testing.T, writer *zip.Writer, name string, data []byte) {
	t.Helper()
	w, err := writer.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(data); err != nil {
		t.Fatal(err)
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
