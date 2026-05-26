package bundle

import (
	"archive/zip"
	"crypto/sha256"
	"image"
	_ "image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAnalyzeSampleBundle(t *testing.T) {
	path := sampleBundle(t)
	info, err := Analyze(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Signature != "UnityFS" {
		t.Fatalf("signature = %q", info.Signature)
	}
	if info.FormatVersion != 7 {
		t.Fatalf("version = %d", info.FormatVersion)
	}
	if info.EngineVersion != "2021.2.18f1" {
		t.Fatalf("engine = %q", info.EngineVersion)
	}
	if info.Compression != CompressionLZ4HC {
		t.Fatalf("compression = %s", info.Compression)
	}
	if info.NodeCount == 0 {
		t.Fatal("node count should be > 0")
	}
}

func TestExtractReplaceBuildSampleBundle(t *testing.T) {
	path := sampleBundle(t)
	tmp := t.TempDir()
	workDir := filepath.Join(tmp, "bundle")
	manifest, err := Extract(path, workDir, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Nodes) == 0 {
		t.Fatal("no nodes extracted")
	}
	node := manifest.Nodes[0]
	replacement := filepath.Join(tmp, "replacement.bin")
	if err := os.WriteFile(replacement, []byte("bundle node replacement"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ReplaceNode(workDir, node.ID, replacement); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(tmp, "rebuilt.bundle")
	if err := Build(workDir, out); err != nil {
		t.Fatal(err)
	}
	rebuilt, err := Analyze(out)
	if err != nil {
		t.Fatal(err)
	}
	if rebuilt.NodeCount != len(manifest.Nodes) {
		t.Fatalf("rebuilt node count = %d, want %d", rebuilt.NodeCount, len(manifest.Nodes))
	}
	verifyDir := filepath.Join(tmp, "verify")
	verifyManifest, err := Extract(out, verifyDir, false)
	if err != nil {
		t.Fatal(err)
	}
	var rebuiltNode Node
	for _, item := range verifyManifest.Nodes {
		if item.ID == node.ID {
			rebuiltNode = item
			break
		}
	}
	if rebuiltNode.ID == "" {
		t.Fatal("replaced node missing after rebuild")
	}
	data, err := os.ReadFile(filepath.Join(verifyDir, "files", rebuiltNode.FileName))
	if err != nil {
		t.Fatal(err)
	}
	want, _ := os.ReadFile(replacement)
	if sha256.Sum256(data) != sha256.Sum256(want) {
		t.Fatal("replacement content mismatch")
	}
}

func TestExtractSampleCodeResources(t *testing.T) {
	path := sampleBundleByName(t, "assetsluascripts")
	tmp := t.TempDir()
	manifest, err := Extract(path, filepath.Join(tmp, "bundle"), false)
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Resources) == 0 {
		t.Fatal("expected serialized resources")
	}
	foundText := false
	for _, resource := range manifest.Resources {
		if resource.Kind == "text" {
			foundText = true
			data, err := os.ReadFile(filepath.Join(tmp, "bundle", "resources", resource.FileName))
			if err != nil {
				t.Fatal(err)
			}
			if len(data) == 0 {
				t.Fatal("text resource should not be empty")
			}
			break
		}
	}
	if !foundText {
		t.Fatalf("expected text/code resource, got %d resources", len(manifest.Resources))
	}
}

func TestExtractSampleImageResources(t *testing.T) {
	path := sampleBundleByName(t, "bulletcomresbullettex")
	tmp := t.TempDir()
	manifest, err := Extract(path, filepath.Join(tmp, "bundle"), false)
	if err != nil {
		t.Fatal(err)
	}
	foundImage := false
	for _, resource := range manifest.Resources {
		if resource.Kind == "image" {
			foundImage = true
			break
		}
	}
	if !foundImage {
		t.Fatalf("expected image resource, got %d resources", len(manifest.Resources))
	}
}

func TestExtractSampleTexturePreviewPNG(t *testing.T) {
	path := sampleBundleByName(t, "bulletcomresbullettex")
	tmp := t.TempDir()
	workDir := filepath.Join(tmp, "bundle")
	manifest, err := Extract(path, workDir, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, resource := range manifest.Resources {
		if resource.ClassID != classTexture2D || filepath.Ext(resource.FileName) != ".png" {
			continue
		}
		file, err := os.Open(filepath.Join(workDir, "resources", resource.FileName))
		if err != nil {
			t.Fatal(err)
		}
		img, _, err := image.Decode(file)
		_ = file.Close()
		if err != nil {
			t.Fatal(err)
		}
		if img.Bounds().Dx() == 0 || img.Bounds().Dy() == 0 {
			t.Fatal("decoded Texture2D preview image is empty")
		}
		if !strings.Contains(resource.Details, "texture_format") {
			t.Fatalf("missing texture details: %q", resource.Details)
		}
		return
	}
	t.Fatalf("expected decodable Texture2D PNG resource, got %d resources", len(manifest.Resources))
}

func TestReplaceTextAssetResourceBuild(t *testing.T) {
	path := sampleBundleByName(t, "assetsluascripts")
	tmp := t.TempDir()
	workDir := filepath.Join(tmp, "bundle")
	manifest, err := Extract(path, workDir, false)
	if err != nil {
		t.Fatal(err)
	}
	var textResource Resource
	for _, resource := range manifest.Resources {
		if resource.Kind == "text" && resource.Replaceable {
			textResource = resource
			break
		}
	}
	if textResource.ID == "" {
		t.Fatal("replaceable text resource not found")
	}
	replacement := filepath.Join(tmp, "replacement.lua")
	want := []byte("return { patched = true }\n")
	if err := os.WriteFile(replacement, want, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ReplaceResource(workDir, textResource.ID, replacement); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(tmp, "rebuilt.bundle")
	if err := Build(workDir, out); err != nil {
		t.Fatal(err)
	}
	verifyDir := filepath.Join(tmp, "verify")
	verify, err := Extract(out, verifyDir, false)
	if err != nil {
		t.Fatal(err)
	}
	var found Resource
	for _, resource := range verify.Resources {
		if resource.ID == textResource.ID {
			found = resource
			break
		}
	}
	if found.ID == "" {
		t.Fatal("text resource missing after rebuild")
	}
	data, err := os.ReadFile(filepath.Join(verifyDir, "resources", found.FileName))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != string(want) {
		t.Fatalf("text replacement mismatch: %q", string(data))
	}
}

func sampleBundle(t *testing.T) string {
	t.Helper()
	return sampleBundleByName(t, "")
}

func sampleBundleByName(t *testing.T, contains string) string {
	t.Helper()
	matches, _ := filepath.Glob(filepath.Join("..", "..", "apk", "*.apk"))
	if len(matches) == 0 {
		t.Skip("sample APK not found")
	}
	reader, err := zip.OpenReader(matches[0])
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	tmp := t.TempDir()
	for _, file := range reader.File {
		if !strings.HasSuffix(file.Name, ".bundle") {
			continue
		}
		if contains != "" && !strings.Contains(file.Name, contains) {
			continue
		}
		rc, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			t.Fatal(err)
		}
		out := filepath.Join(tmp, filepath.Base(file.Name))
		if err := os.WriteFile(out, data, 0o644); err != nil {
			t.Fatal(err)
		}
		return out
	}
	t.Skip("sample Bundle not found")
	return ""
}
