package project

import (
	"crypto/sha1"
	"encoding/hex"
	"path/filepath"
	"strings"

	"apkworkshop/internal/apk"
	"apkworkshop/internal/bundle"
)

type Project struct {
	APKPath  string
	WorkDir  string
	DistDir  string
	Scan     apk.ScanReport
	Manifest apk.Manifest
}

func New(apkPath string) (*Project, error) {
	if apkPath == "" {
		apkPath = apk.DefaultAPK()
	}
	if apkPath == "" {
		return nil, nil
	}
	scan, err := apk.Scan(apkPath)
	if err != nil {
		return nil, err
	}
	name := strings.TrimSuffix(filepath.Base(apkPath), filepath.Ext(apkPath))
	return &Project{
		APKPath: apkPath,
		WorkDir: filepath.Join("work", name),
		DistDir: "dist",
		Scan:    scan,
	}, nil
}

func (p *Project) Extract(force bool) error {
	manifest, err := apk.Extract(p.APKPath, p.WorkDir, force)
	if err != nil {
		return err
	}
	p.Manifest = manifest
	return nil
}

func (p *Project) LoadManifest() error {
	manifest, err := apk.LoadManifest(p.WorkDir)
	if err != nil {
		return err
	}
	p.Manifest = manifest
	return nil
}

func (p *Project) Replace(entryPath string, sourcePath string) (apk.Replacement, error) {
	record, manifest, err := apk.Replace(p.WorkDir, entryPath, sourcePath)
	if err != nil {
		return apk.Replacement{}, err
	}
	p.Manifest = manifest
	return record, nil
}

func (p *Project) BundleWorkDir(bundlePath string) string {
	sum := sha1.Sum([]byte(bundlePath))
	return filepath.Join(p.WorkDir, ".apkworkshop", "bundles", hex.EncodeToString(sum[:8]))
}

func (p *Project) AnalyzeBundle(bundlePath string) (bundle.Info, error) {
	return bundle.Analyze(filepath.Join(p.WorkDir, filepath.FromSlash(bundlePath)))
}

func (p *Project) ExtractBundle(bundlePath string, force bool) (bundle.Manifest, error) {
	return bundle.Extract(filepath.Join(p.WorkDir, filepath.FromSlash(bundlePath)), p.BundleWorkDir(bundlePath), force)
}

func (p *Project) LoadBundleManifest(bundlePath string) (bundle.Manifest, error) {
	return bundle.LoadManifest(p.BundleWorkDir(bundlePath))
}

func (p *Project) ReplaceBundleNode(bundlePath string, nodeID string, sourcePath string) (bundle.Replacement, error) {
	record, _, err := bundle.ReplaceNode(p.BundleWorkDir(bundlePath), nodeID, sourcePath)
	if err != nil {
		return bundle.Replacement{}, err
	}
	manifest, err := apk.MarkBundleNodeReplacement(p.WorkDir, bundlePath, record.NodeID, record.NodePath, record.SourcePath, record.Size, record.CRC)
	if err != nil {
		return bundle.Replacement{}, err
	}
	p.Manifest = manifest
	return record, nil
}

func (p *Project) ReplaceBundleResource(bundlePath string, resourceID string, sourcePath string) (bundle.Replacement, error) {
	record, _, err := bundle.ReplaceResource(p.BundleWorkDir(bundlePath), resourceID, sourcePath)
	if err != nil {
		return bundle.Replacement{}, err
	}
	manifest, err := apk.MarkBundleNodeReplacement(p.WorkDir, bundlePath, record.NodeID, record.NodePath, record.SourcePath, record.Size, record.CRC)
	if err != nil {
		return bundle.Replacement{}, err
	}
	p.Manifest = manifest
	return record, nil
}

func (p *Project) BuildBundle(bundlePath string) error {
	if err := bundle.Build(p.BundleWorkDir(bundlePath), filepath.Join(p.WorkDir, filepath.FromSlash(bundlePath))); err != nil {
		return err
	}
	manifest, err := apk.LoadManifest(p.WorkDir)
	if err != nil {
		return err
	}
	p.Manifest = manifest
	return nil
}

func (p *Project) Build() (apk.BuildResult, error) {
	name := strings.TrimSuffix(filepath.Base(p.APKPath), filepath.Ext(p.APKPath))
	return apk.Build(p.WorkDir, filepath.Join(p.DistDir, name+"-unsigned.apk"))
}
