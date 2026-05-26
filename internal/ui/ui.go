package ui

import (
	"bytes"
	"encoding/hex"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"apkworkshop/internal/apk"
	"apkworkshop/internal/bundle"
	"apkworkshop/internal/preview"
	"apkworkshop/internal/project"
	signstatus "apkworkshop/internal/sign"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/app"
	"fyne.io/fyne/v2/canvas"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/storage"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"
	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/webp"
)

const appTitle = "APK Workshop"

const (
	bundleResourcesGroupID = "bundle_resources"
	bundleImagesGroupID    = "bundle_images"
	bundleTextsGroupID     = "bundle_texts"
	bundleAudioGroupID     = "bundle_audio"
	bundleOtherGroupID     = "bundle_other"
)

type filterGroup struct {
	ID    string
	Label string
	Match func(apk.Entry) bool
}

type bundleResourceItem struct {
	BundlePath string
	Entry      apk.Entry
	Resource   bundle.Resource
}

type appState struct {
	app    fyne.App
	window fyne.Window

	project   *project.Project
	currentID string
	selected  string
	lastBuild string

	groups      []filterGroup
	groupList   *widget.List
	searchEntry *widget.Entry
	table       *widget.Table
	previewBox  *fyne.Container
	logEntry    *widget.Entry
	summary     *widget.Label
	toolStatus  *widget.Label

	filtered           []apk.Entry
	bundleResources    []bundleResourceItem
	selectedBundleNode string
	selectedResource   string
}

func Run() {
	fyneApp := app.NewWithID("cn.apkworkshop.desktop")
	window := fyneApp.NewWindow(appTitle)
	window.Resize(fyne.NewSize(1120, 720))
	window.SetMaster()

	state := &appState{
		app:       fyneApp,
		window:    window,
		currentID: "all",
		groups:    defaultGroups(),
	}
	window.SetContent(state.buildUI())
	state.bootstrap()
	window.ShowAndRun()
}

func (s *appState) buildUI() fyne.CanvasObject {
	s.summary = widget.NewLabel("请选择 APK 或使用 apk/ 下的默认样例")
	s.summary.Truncation = fyne.TextTruncateEllipsis
	s.summary.Wrapping = fyne.TextWrapBreak
	s.toolStatus = widget.NewLabel(shortToolStatusText())
	s.toolStatus.Truncation = fyne.TextTruncateEllipsis

	toolbar := widget.NewToolbar(
		widget.NewToolbarAction(theme.FolderOpenIcon(), s.chooseAPK),
		widget.NewToolbarAction(theme.MoveDownIcon(), s.extractCurrent),
		widget.NewToolbarAction(theme.ContentCopyIcon(), s.replaceSelected),
		widget.NewToolbarSeparator(),
		widget.NewToolbarAction(theme.DocumentSaveIcon(), s.buildCurrent),
		widget.NewToolbarAction(theme.ConfirmIcon(), s.signCurrent),
		widget.NewToolbarSpacer(),
		widget.NewToolbarAction(theme.InfoIcon(), func() {
			dialog.ShowInformation("工具状态", signstatus.StatusText(), s.window)
		}),
		widget.NewToolbarAction(theme.FolderIcon(), func() {
			s.openPath("dist")
		}),
	)
	bulkBundleButton := widget.NewButtonWithIcon("解包全部Bundle", theme.DownloadIcon(), s.extractAllBundles)
	toolbarRow := container.NewBorder(nil, nil, nil, bulkBundleButton, toolbar)
	header := container.NewBorder(nil, nil, nil, s.toolStatus, container.NewVBox(toolbarRow, s.summary))

	s.groupList = widget.NewList(
		func() int { return len(s.groups) },
		func() fyne.CanvasObject { return widget.NewLabel("资源") },
		func(id widget.ListItemID, item fyne.CanvasObject) {
			item.(*widget.Label).SetText(s.groupLabel(s.groups[id]))
		},
	)
	s.groupList.OnSelected = func(id widget.ListItemID) {
		s.currentID = s.groups[id].ID
		s.applyFilter()
	}
	s.groupList.Select(0)

	s.searchEntry = widget.NewEntry()
	s.searchEntry.SetPlaceHolder("搜索 APK 内路径")
	s.searchEntry.OnChanged = func(string) { s.applyFilter() }

	left := container.NewBorder(widget.NewLabel("资源分组"), nil, nil, nil, s.groupList)

	s.table = widget.NewTable(
		func() (int, int) {
			if s.isBundleResourceMode() {
				return len(s.bundleResources) + 1, 5
			}
			return len(s.filtered) + 1, 5
		},
		func() fyne.CanvasObject {
			label := widget.NewLabel("")
			label.Truncation = fyne.TextTruncateEllipsis
			return label
		},
		func(id widget.TableCellID, item fyne.CanvasObject) {
			label := item.(*widget.Label)
			label.TextStyle.Bold = id.Row == 0
			label.SetText(s.tableCell(id))
		},
	)
	s.configureTableColumns()
	s.table.OnSelected = func(id widget.TableCellID) {
		if id.Row == 0 {
			return
		}
		if s.isBundleResourceMode() {
			if id.Row-1 >= len(s.bundleResources) {
				return
			}
			item := s.bundleResources[id.Row-1]
			s.selected = item.BundlePath
			s.selectedResource = item.Resource.ID
			s.selectedBundleNode = item.Resource.NodeID
			s.showBundleResourcePreview(item)
			return
		}
		if id.Row-1 >= len(s.filtered) {
			return
		}
		entry := s.filtered[id.Row-1]
		s.selected = entry.Path
		s.showPreview(entry)
	}

	s.previewBox = container.NewStack(centerLabel("选择资源后预览"))
	s.logEntry = widget.NewMultiLineEntry()
	s.logEntry.SetPlaceHolder("操作日志")
	s.logEntry.Wrapping = fyne.TextWrapBreak
	s.logEntry.Disable()
	s.logEntry.SetMinRowsVisible(4)

	center := container.NewBorder(s.searchEntry, nil, nil, nil, s.table)
	right := container.NewBorder(widget.NewLabel("预览"), nil, nil, nil, s.previewBox)
	workspace := container.NewHSplit(center, right)
	workspace.Offset = 0.62
	body := container.NewHSplit(left, workspace)
	body.Offset = 0.18

	return container.NewBorder(header, s.logEntry, nil, nil, body)
}

func (s *appState) bootstrap() {
	defaultAPK := apk.DefaultAPK()
	if defaultAPK == "" {
		s.log("未发现 apk/*.apk，请点击“选择 APK”。")
		s.refresh()
		return
	}
	s.loadAPK(defaultAPK)
}

func (s *appState) chooseAPK() {
	open := dialog.NewFileOpen(func(reader fyne.URIReadCloser, err error) {
		if err != nil {
			s.showError("选择 APK 失败", err)
			return
		}
		if reader == nil {
			return
		}
		defer reader.Close()
		s.loadAPK(uriPath(reader.URI()))
	}, s.window)
	open.SetFilter(storage.NewExtensionFileFilter([]string{".apk"}))
	open.Show()
}

func (s *appState) loadAPK(path string) {
	if path == "" {
		return
	}
	p, err := project.New(path)
	if err != nil {
		s.showError("扫描 APK 失败", err)
		return
	}
	s.project = p
	s.selected = ""
	s.lastBuild = ""
	if err := p.LoadManifest(); err == nil {
		s.log("已加载 APK：%s，发现已有工作区清单。", p.Scan.Name)
	} else {
		s.log("已扫描 APK：%s。点击“解包”生成工作区。", p.Scan.Name)
	}
	s.applyFilter()
	s.refresh()
}

func (s *appState) extractAllBundles() {
	if !s.hasManifest() {
		return
	}
	bundles := make([]apk.Entry, 0)
	for _, entry := range s.project.Manifest.Entries {
		if !entry.IsDir && entry.Kind == apk.KindBundle {
			bundles = append(bundles, entry)
		}
	}
	if len(bundles) == 0 {
		dialog.ShowInformation("没有 Bundle", "当前 APK 清单中没有 .bundle 文件。", s.window)
		return
	}
	dialog.NewConfirm("解包全部 Bundle", fmt.Sprintf("将解包 %d 个 Bundle，并覆盖已有 Bundle 工作区。", len(bundles)), func(ok bool) {
		if !ok {
			return
		}
		s.runExtractAllBundles(bundles)
	}, s.window).Show()
}

func (s *appState) runExtractAllBundles(bundles []apk.Entry) {
	progress := dialog.NewProgress("解包全部 Bundle", "正在解包 Bundle 资源...", s.window)
	progress.Show()
	go func() {
		success := 0
		failures := make([]string, 0)
		for index, entry := range bundles {
			if _, err := s.project.ExtractBundle(entry.Path, true); err != nil {
				failures = append(failures, fmt.Sprintf("%s: %v", entry.Path, err))
			} else {
				success++
			}
			value := float64(index+1) / float64(len(bundles))
			fyne.Do(func() {
				progress.SetValue(value)
			})
		}
		fyne.Do(func() {
			progress.Hide()
			s.applyFilter()
			s.refresh()
			s.log("全部 Bundle 解包完成：成功 %d 个，失败 %d 个。", success, len(failures))
			if len(failures) > 0 {
				dialog.ShowInformation("部分 Bundle 解包失败", failureSummary(failures), s.window)
				return
			}
			if !s.isBundleResourceMode() {
				s.selectGroup(bundleResourcesGroupID)
			}
		})
	}()
}

func (s *appState) extractCurrent() {
	if !s.hasProject() {
		return
	}
	run := func(force bool) {
		if err := s.project.Extract(force); err != nil {
			s.showError("解包失败", err)
			return
		}
		s.log("解包完成：%s", s.project.WorkDir)
		s.applyFilter()
		s.refresh()
	}
	if stat, err := os.Stat(s.project.WorkDir); err == nil && stat.IsDir() {
		dialog.NewConfirm("覆盖工作区", "工作区已存在，继续会重建该目录。", func(ok bool) {
			if ok {
				run(true)
			}
		}, s.window).Show()
		return
	}
	run(false)
}

func (s *appState) replaceSelected() {
	if !s.hasManifest() {
		return
	}
	entry, ok := s.selectedEntry()
	if !ok {
		dialog.ShowInformation("未选择资源", "请先在资源表中选择要替换的文件。", s.window)
		return
	}
	if !entry.Replaceable {
		dialog.ShowInformation("暂不支持替换", "首版不替换签名文件、dex 和 so。", s.window)
		return
	}
	s.replaceAPKEntry(entry, func() {
		s.showPreviewByPath(entry.Path)
	})
}

func (s *appState) replaceAPKEntry(entry apk.Entry, after func()) {
	open := dialog.NewFileOpen(func(reader fyne.URIReadCloser, err error) {
		if err != nil {
			s.showError("选择替换文件失败", err)
			return
		}
		if reader == nil {
			return
		}
		defer reader.Close()
		source := uriPath(reader.URI())
		record, err := s.project.Replace(entry.Path, source)
		if err != nil {
			s.showError("替换失败", err)
			return
		}
		if entry.Kind == apk.KindBundle {
			if err := os.RemoveAll(s.project.BundleWorkDir(entry.Path)); err != nil {
				s.showError("清理 Bundle 工作区失败", err)
				return
			}
			s.log("Bundle 工作区已清理，需要重新解包：%s", entry.Path)
		}
		s.log("已替换：%s <- %s (%d bytes)", record.Path, filepath.Base(record.SourcePath), record.Size)
		s.applyFilter()
		if after != nil {
			after()
		}
		s.refresh()
	}, s.window)
	open.Show()
}

func (s *appState) buildCurrent() {
	if !s.hasManifest() {
		return
	}
	result, err := s.project.Build()
	if err != nil {
		s.showError("封包失败", err)
		return
	}
	s.lastBuild = result.OutputAPK
	s.log("%s：%s", result.Message, result.OutputAPK)
	dialog.ShowInformation("封包完成", fmt.Sprintf("%s\n%s", result.Message, result.OutputAPK), s.window)
}

func (s *appState) signCurrent() {
	if !s.hasManifest() {
		return
	}
	unsigned := s.lastBuild
	if unsigned == "" {
		result, err := s.project.Build()
		if err != nil {
			s.showError("签名前封包失败", err)
			return
		}
		unsigned = result.OutputAPK
		s.lastBuild = unsigned
		s.log("%s：%s", result.Message, unsigned)
	}
	name := strings.TrimSuffix(filepath.Base(s.project.APKPath), filepath.Ext(s.project.APKPath))
	signed := filepath.Join(s.project.DistDir, name+"-debug.apk")
	keystore := filepath.Join(".apkworkshop", "debug.keystore")
	result, err := apk.SignDebug(unsigned, signed, keystore)
	if err != nil {
		s.showError("签名不可用", err)
		s.log("签名失败：%v", err)
		s.refresh()
		return
	}
	s.log("%s：%s", result.Message, result.OutputAPK)
	dialog.ShowInformation("签名完成", result.OutputAPK, s.window)
	s.refresh()
}

func (s *appState) applyFilter() {
	if s.project == nil {
		s.filtered = nil
		s.bundleResources = nil
		s.refresh()
		return
	}
	query := ""
	if s.searchEntry != nil {
		query = strings.ToLower(strings.TrimSpace(s.searchEntry.Text))
	}
	if s.isBundleResourceMode() {
		if s.searchEntry != nil {
			s.searchEntry.SetPlaceHolder("搜索 Bundle 资源名称/类型/路径")
		}
		s.filtered = nil
		s.bundleResources = s.collectBundleResources(query, s.currentBundleResourceKind())
		s.configureTableColumns()
		if len(s.bundleResources) == 0 && s.previewBox != nil {
			s.previewBox.Objects = []fyne.CanvasObject{centerLabel("未发现已解包的 Bundle 资源")}
			s.previewBox.Refresh()
		}
		s.refresh()
		return
	}
	if s.searchEntry != nil {
		s.searchEntry.SetPlaceHolder("搜索 APK 内路径")
	}
	group := s.currentGroup()
	entries := s.project.Manifest.Entries
	filtered := make([]apk.Entry, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir {
			continue
		}
		if group.Match != nil && !group.Match(entry) {
			continue
		}
		if query != "" && !strings.Contains(strings.ToLower(entry.Path), query) {
			continue
		}
		filtered = append(filtered, entry)
	}
	sort.SliceStable(filtered, func(i, j int) bool {
		return filtered[i].Path < filtered[j].Path
	})
	s.filtered = filtered
	s.configureTableColumns()
	s.refresh()
}

func (s *appState) showPreview(entry apk.Entry) {
	if !s.hasManifest() {
		return
	}
	if entry.Kind == apk.KindBundle {
		s.showBundlePreview(entry)
		return
	}
	result, err := preview.Load(s.project.WorkDir, entry, s.project.Scan)
	if err != nil {
		s.previewBox.Objects = []fyne.CanvasObject{centerLabel(fmt.Sprintf("预览失败：%v", err))}
		s.previewBox.Refresh()
		return
	}
	s.previewBox.Objects = []fyne.CanvasObject{s.previewObject(result)}
	s.previewBox.Refresh()
}

func (s *appState) showBundlePreview(entry apk.Entry) {
	info, err := s.project.AnalyzeBundle(entry.Path)
	if err != nil {
		s.previewBox.Objects = []fyne.CanvasObject{centerLabel(fmt.Sprintf("Bundle 解析失败：%v", err))}
		s.previewBox.Refresh()
		return
	}
	manifest, manifestErr := s.project.LoadBundleManifest(entry.Path)
	nodes := info.Nodes
	resources := []bundle.Resource{}
	if manifestErr == nil {
		nodes = manifest.Nodes
		resources = manifest.Resources
	}
	selectedNode := ""
	selectedResource := ""
	showResources := len(resources) > 0
	table := widget.NewTable(
		func() (int, int) {
			if showResources {
				return len(resources) + 1, 5
			}
			return len(nodes) + 1, 4
		},
		func() fyne.CanvasObject {
			label := widget.NewLabel("")
			label.Truncation = fyne.TextTruncateEllipsis
			return label
		},
		func(id widget.TableCellID, item fyne.CanvasObject) {
			label := item.(*widget.Label)
			label.TextStyle.Bold = id.Row == 0
			if showResources {
				label.SetText(bundleResourceCell(resources, id))
				return
			}
			label.SetText(bundleNodeCell(nodes, id))
		},
	)
	table.SetColumnWidth(0, 160)
	table.SetColumnWidth(1, 72)
	table.SetColumnWidth(2, 72)
	table.SetColumnWidth(3, 64)
	table.SetColumnWidth(4, 44)
	table.OnSelected = func(id widget.TableCellID) {
		if id.Row == 0 {
			return
		}
		if showResources {
			if id.Row-1 >= len(resources) {
				return
			}
			selectedResource = resources[id.Row-1].ID
			selectedNode = resources[id.Row-1].NodeID
			s.selectedResource = selectedResource
			s.selectedBundleNode = selectedNode
			return
		}
		if id.Row-1 >= len(nodes) {
			return
		}
		selectedNode = nodes[id.Row-1].ID
		s.selectedBundleNode = selectedNode
	}

	summary := widget.NewLabel(bundleInfoText(entry, info, manifestErr == nil))
	summary.Wrapping = fyne.TextWrapWord

	extractButton := widget.NewButtonWithIcon("解包", theme.MoveDownIcon(), func() {
		force := manifestErr == nil
		if force {
			dialog.NewConfirm("覆盖 Bundle 工作区", "该 Bundle 已解包，继续会重建内部文件目录。", func(ok bool) {
				if ok {
					s.extractBundle(entry)
				}
			}, s.window).Show()
			return
		}
		s.extractBundle(entry)
	})
	replaceButton := widget.NewButtonWithIcon("替换资源", theme.ContentCopyIcon(), func() {
		if showResources {
			resourceID := selectedResource
			if resourceID == "" {
				resourceID = s.selectedResource
			}
			s.replaceBundleResource(entry, resourceID)
			return
		}
		nodeID := selectedNode
		if nodeID == "" {
			nodeID = s.selectedBundleNode
		}
		s.replaceBundleNode(entry, nodeID)
	})
	buildButton := widget.NewButtonWithIcon("封包Bundle", theme.DocumentSaveIcon(), func() {
		s.buildBundle(entry)
	})
	previewButton := widget.NewButtonWithIcon("预览资源", theme.SearchIcon(), func() {
		resourceID := selectedResource
		if resourceID == "" {
			resourceID = s.selectedResource
		}
		if showResources {
			s.previewBundleResource(entry, resourceID)
			return
		}
		nodeID := selectedNode
		if nodeID == "" {
			nodeID = s.selectedBundleNode
		}
		s.previewBundleNode(entry, nodeID)
	})
	if manifestErr != nil {
		replaceButton.Disable()
		buildButton.Disable()
		previewButton.Disable()
	}
	if showResources && s.selectedResource != "" {
		for index, resource := range resources {
			if resource.ID == s.selectedResource {
				table.Select(widget.TableCellID{Row: index + 1, Col: 0})
				break
			}
		}
	}

	actions := container.NewHBox(extractButton, previewButton, replaceButton, buildButton)
	content := container.NewBorder(container.NewVBox(summary, actions), nil, nil, nil, table)
	s.previewBox.Objects = []fyne.CanvasObject{content}
	s.previewBox.Refresh()
}

func (s *appState) extractBundle(entry apk.Entry) {
	manifest, err := s.project.ExtractBundle(entry.Path, true)
	if err != nil {
		s.showError("Bundle 解包失败", err)
		return
	}
	s.log("Bundle 解包完成：%s，节点 %d 个，资源 %d 个", entry.Path, len(manifest.Nodes), len(manifest.Resources))
	s.applyFilter()
	s.showBundlePreview(entry)
}

func (s *appState) replaceBundleNode(entry apk.Entry, nodeID string) {
	if nodeID == "" {
		dialog.ShowInformation("未选择节点", "请先在 Bundle 节点表中选择要替换的节点。", s.window)
		return
	}
	open := dialog.NewFileOpen(func(reader fyne.URIReadCloser, err error) {
		if err != nil {
			s.showError("选择替换文件失败", err)
			return
		}
		if reader == nil {
			return
		}
		defer reader.Close()
		record, err := s.project.ReplaceBundleNode(entry.Path, nodeID, uriPath(reader.URI()))
		if err != nil {
			s.showError("Bundle 节点替换失败", err)
			return
		}
		s.log("Bundle 节点已替换：%s -> %s", entry.Path, record.NodePath)
		s.applyFilter()
		s.showBundlePreview(entry)
	}, s.window)
	open.Show()
}

func (s *appState) replaceBundleResource(entry apk.Entry, resourceID string) {
	if resourceID == "" {
		dialog.ShowInformation("未选择资源", "请先在 Bundle 资源表中选择要替换的资源。", s.window)
		return
	}
	manifest, err := s.project.LoadBundleManifest(entry.Path)
	if err != nil {
		s.showError("读取 Bundle 清单失败", err)
		return
	}
	var selected bundle.Resource
	for _, resource := range manifest.Resources {
		if resource.ID == resourceID {
			selected = resource
			break
		}
	}
	if selected.ID == "" {
		dialog.ShowInformation("资源不存在", "Bundle 工作区清单中没有该资源。", s.window)
		return
	}
	if !selected.Replaceable {
		dialog.ShowInformation("暂不支持替换", "当前仅支持 TextAsset 代码/文本资源内容替换；图片资源已识别但暂不做像素写回。", s.window)
		return
	}
	open := dialog.NewFileOpen(func(reader fyne.URIReadCloser, err error) {
		if err != nil {
			s.showError("选择替换文件失败", err)
			return
		}
		if reader == nil {
			return
		}
		defer reader.Close()
		record, err := s.project.ReplaceBundleResource(entry.Path, resourceID, uriPath(reader.URI()))
		if err != nil {
			s.showError("Bundle 资源替换失败", err)
			return
		}
		s.log("Bundle 资源已替换：%s -> %s", entry.Path, record.ResourceID)
		s.applyFilter()
		s.showBundlePreview(entry)
	}, s.window)
	open.Show()
}

func (s *appState) buildBundle(entry apk.Entry) {
	if err := s.project.BuildBundle(entry.Path); err != nil {
		s.showError("Bundle 封包失败", err)
		return
	}
	s.log("Bundle 封包完成并写回工作区：%s", entry.Path)
	s.applyFilter()
	s.showBundlePreview(entry)
}

func (s *appState) previewBundleNode(entry apk.Entry, nodeID string) {
	if nodeID == "" {
		dialog.ShowInformation("未选择节点", "请先在 Bundle 节点表中选择要预览的节点。", s.window)
		return
	}
	manifest, err := s.project.LoadBundleManifest(entry.Path)
	if err != nil {
		s.showError("读取 Bundle 清单失败", err)
		return
	}
	for _, node := range manifest.Nodes {
		if node.ID != nodeID {
			continue
		}
		path := filepath.Join(s.project.BundleWorkDir(entry.Path), "files", node.FileName)
		view, err := bundleNodePreviewView(path, node)
		if err != nil {
			s.showError("节点预览失败", err)
			return
		}
		s.previewBox.Objects = []fyne.CanvasObject{s.wrapBundleDetail(
			"节点预览",
			entry,
			func() { s.showBundlePreview(entry) },
			view,
		)}
		s.previewBox.Refresh()
		return
	}
	dialog.ShowInformation("节点不存在", "Bundle 工作区清单中没有该节点。", s.window)
}

func (s *appState) previewBundleResource(entry apk.Entry, resourceID string) {
	if resourceID == "" {
		dialog.ShowInformation("未选择资源", "请先在 Bundle 资源表中选择要预览的资源。", s.window)
		return
	}
	manifest, err := s.project.LoadBundleManifest(entry.Path)
	if err != nil {
		s.showError("读取 Bundle 清单失败", err)
		return
	}
	for _, resource := range manifest.Resources {
		if resource.ID != resourceID {
			continue
		}
		path := filepath.Join(s.project.BundleWorkDir(entry.Path), "resources", resource.FileName)
		data, err := os.ReadFile(path)
		if err != nil {
			s.showError("资源预览失败", err)
			return
		}
		view := bundleResourcePreviewView(resource, data)
		s.previewBox.Objects = []fyne.CanvasObject{s.wrapBundleDetail(
			"资源预览",
			entry,
			func() { s.showBundlePreview(entry) },
			view,
		)}
		s.previewBox.Refresh()
		return
	}
	dialog.ShowInformation("资源不存在", "Bundle 工作区清单中没有该资源。", s.window)
}

func (s *appState) showBundleResourcePreview(item bundleResourceItem) {
	path := filepath.Join(s.project.BundleWorkDir(item.BundlePath), "resources", item.Resource.FileName)
	data, err := os.ReadFile(path)
	if err != nil {
		s.previewBox.Objects = []fyne.CanvasObject{centerLabel(fmt.Sprintf("资源预览失败：%v", err))}
		s.previewBox.Refresh()
		return
	}
	view := bundleResourcePreviewView(item.Resource, data)
	s.previewBox.Objects = []fyne.CanvasObject{s.wrapBundleResourceDetail(item, view)}
	s.previewBox.Refresh()
}

func (s *appState) wrapBundleDetail(title string, entry apk.Entry, back func(), detail fyne.CanvasObject) fyne.CanvasObject {
	titleLabel := widget.NewLabelWithStyle(title, fyne.TextAlignLeading, fyne.TextStyle{Bold: true})
	pathLabel := widget.NewLabel(entry.Path)
	pathLabel.Truncation = fyne.TextTruncateEllipsis
	backButton := widget.NewButtonWithIcon("返回 Bundle", theme.NavigateBackIcon(), back)
	header := container.NewBorder(nil, nil, backButton, nil, container.NewVBox(titleLabel, pathLabel))
	return container.NewBorder(header, nil, nil, nil, detail)
}

func (s *appState) wrapBundleResourceDetail(item bundleResourceItem, detail fyne.CanvasObject) fyne.CanvasObject {
	titleLabel := widget.NewLabelWithStyle("Bundle 资源预览", fyne.TextAlignLeading, fyne.TextStyle{Bold: true})
	pathLabel := widget.NewLabel(fmt.Sprintf("%s | %s", item.Resource.Name, item.BundlePath))
	pathLabel.Truncation = fyne.TextTruncateEllipsis
	jumpButton := widget.NewButtonWithIcon("跳转 Bundle", theme.NavigateNextIcon(), func() {
		s.openBundleForResource(item)
	})
	replaceButton := widget.NewButtonWithIcon("替换整Bundle", theme.ContentCopyIcon(), func() {
		s.replaceAPKEntry(item.Entry, func() {
			s.applyFilter()
			s.showBundlePreview(item.Entry)
		})
	})
	buildButton := widget.NewButtonWithIcon("封包Bundle", theme.DocumentSaveIcon(), func() {
		s.buildBundle(item.Entry)
	})
	header := container.NewBorder(
		nil,
		nil,
		nil,
		container.NewHBox(jumpButton, replaceButton, buildButton),
		container.NewVBox(titleLabel, pathLabel),
	)
	return container.NewBorder(header, nil, nil, nil, detail)
}

func (s *appState) showPreviewByPath(path string) {
	for _, entry := range s.filtered {
		if entry.Path == path {
			s.showPreview(entry)
			return
		}
	}
	if entry, ok := s.entryByPath(path); ok {
		s.showPreview(entry)
	}
}

func (s *appState) openBundleForResource(item bundleResourceItem) {
	s.selected = item.BundlePath
	s.selectedResource = item.Resource.ID
	s.selectedBundleNode = item.Resource.NodeID
	if s.searchEntry != nil && s.searchEntry.Text != "" {
		s.searchEntry.SetText("")
	}
	s.selectGroup("bundles")
	s.showBundlePreview(item.Entry)
	s.log("已跳转 Bundle：%s，资源：%s", item.BundlePath, item.Resource.Name)
}

func (s *appState) selectGroup(id string) {
	s.currentID = id
	if s.groupList != nil {
		for index, group := range s.groups {
			if group.ID == id {
				s.groupList.Select(index)
				return
			}
		}
	}
	s.applyFilter()
}

func (s *appState) previewObject(result preview.Result) fyne.CanvasObject {
	switch result.Mode {
	case "image":
		img := canvas.NewImageFromImage(result.Image)
		img.FillMode = canvas.ImageFillContain
		summary := widget.NewLabel(result.Summary)
		summary.Truncation = fyne.TextTruncateEllipsis
		summary.Wrapping = fyne.TextWrapBreak
		return container.NewBorder(summary, nil, nil, nil, img)
	case "text":
		text := widget.NewMultiLineEntry()
		text.SetText(result.Text)
		text.Wrapping = fyne.TextWrapBreak
		text.Disable()
		return text
	default:
		label := widget.NewLabel(result.Summary)
		label.Wrapping = fyne.TextWrapWord
		return container.NewScroll(label)
	}
}

func bundleResourcePreviewView(resource bundle.Resource, data []byte) fyne.CanvasObject {
	meta := widget.NewLabel(bundleResourceMetaText(resource))
	meta.Wrapping = fyne.TextWrapBreak
	meta.Truncation = fyne.TextTruncateEllipsis
	if resource.Kind == "image" && strings.EqualFold(filepath.Ext(resource.FileName), ".png") {
		img, _, err := image.Decode(bytes.NewReader(data))
		if err == nil {
			canvasImage := canvas.NewImageFromImage(img)
			canvasImage.FillMode = canvas.ImageFillContain
			return container.NewBorder(meta, nil, nil, nil, canvasImage)
		}
	}
	if resource.Kind == "text" {
		text := widget.NewMultiLineEntry()
		text.SetText(string(data))
		text.Wrapping = fyne.TextWrapBreak
		text.Disable()
		return container.NewBorder(meta, nil, nil, nil, text)
	}
	text := widget.NewMultiLineEntry()
	text.SetText(bundleStructuredPreview(resource, data))
	text.Wrapping = fyne.TextWrapBreak
	text.Disable()
	return container.NewBorder(meta, nil, nil, nil, text)
}

func bundleNodePreviewView(path string, node bundle.Node) (fyne.CanvasObject, error) {
	meta := widget.NewLabel(bundleNodeMetaText(node))
	meta.Wrapping = fyne.TextWrapBreak
	meta.Truncation = fyne.TextTruncateEllipsis
	if node.Kind == "image" {
		file, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		img, _, err := image.Decode(file)
		_ = file.Close()
		if err == nil {
			canvasImage := canvas.NewImageFromImage(img)
			canvasImage.FillMode = canvas.ImageFillContain
			return container.NewBorder(meta, nil, nil, nil, canvasImage), nil
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	text := widget.NewMultiLineEntry()
	if node.Kind == "text" {
		text.SetText(string(data))
	} else {
		text.SetText(bundleNodeBinaryPreview(node, data))
	}
	text.Wrapping = fyne.TextWrapBreak
	text.Disable()
	return container.NewBorder(meta, nil, nil, nil, text), nil
}

func bundleResourceMetaText(resource bundle.Resource) string {
	replaceable := "否"
	if resource.Replaceable {
		replaceable = "是"
	}
	changed := "否"
	if resource.Changed {
		changed = "是"
	}
	return fmt.Sprintf(
		"名称: %s\nUnity 类型: %s | 预览类型: %s | ClassID: %d | PathID: %d\n节点: %s\n导出文件: %s | 大小: %s | CRC: %s | 可替换: %s | 已替换: %s%s",
		emptyDash(resource.Name),
		resource.Type,
		resource.Kind,
		resource.ClassID,
		resource.PathID,
		emptyDash(resource.NodePath),
		emptyDash(resource.FileName),
		humanSize(resource.Size),
		emptyDash(resource.CRC),
		replaceable,
		changed,
		bundleDetailsSuffix(resource.Details),
	)
}

func bundleNodeMetaText(node bundle.Node) string {
	changed := "否"
	if node.Changed {
		changed = "是"
	}
	return fmt.Sprintf(
		"路径: %s\n类型: %s | 大小: %s | CRC: %s | 已替换: %s",
		node.Path,
		node.Kind,
		humanSize(node.Size),
		emptyDash(node.CRC),
		changed,
	)
}

func bundleStructuredPreview(resource bundle.Resource, data []byte) string {
	switch resource.Kind {
	case "image":
		if strings.EqualFold(filepath.Ext(resource.FileName), ".png") {
			return "已解码 Unity Texture2D 图片。"
		}
		details := resource.Details
		if details == "" {
			details = string(data)
		}
		return "已识别 Unity 图片对象（Texture2D/Sprite）。\n当前格式暂未解码为图片，下面显示对象元数据和原始摘要。\n\n" + details
	case "audio":
		details := resource.Details
		if details == "" {
			details = string(data)
		}
		return "已识别 Unity 音频/视频对象。\n当前预览为对象元数据和原始对象摘要；暂未解码音频/视频流。\n\n" + details
	default:
		if looksTextual(data) {
			return string(data)
		}
		return fmt.Sprintf("二进制资源摘要\n大小: %s\n前 256 字节:\n%s", humanSize(int64(len(data))), hexDumpLimit(data, 256))
	}
}

func bundleDetailsSuffix(details string) string {
	if strings.TrimSpace(details) == "" {
		return ""
	}
	return "\n\n" + details
}

func bundleNodeBinaryPreview(node bundle.Node, data []byte) string {
	return fmt.Sprintf(
		"二进制节点摘要\n路径: %s\n大小: %s\nCRC: %s\n前 256 字节:\n%s",
		node.Path,
		humanSize(int64(len(data))),
		emptyDash(node.CRC),
		hexDumpLimit(data, 256),
	)
}

func (s *appState) refresh() {
	if s.summary != nil {
		s.summary.SetText(s.summaryText())
	}
	if s.toolStatus != nil {
		s.toolStatus.SetText(shortToolStatusText())
	}
	if s.groupList != nil {
		s.groupList.Refresh()
	}
	if s.table != nil {
		s.table.Refresh()
	}
}

func (s *appState) summaryText() string {
	if s.project == nil {
		return "未加载 APK"
	}
	scan := s.project.Scan
	manifestCount := len(s.project.Manifest.Entries)
	manifestText := "未解包"
	if manifestCount > 0 {
		manifestText = fmt.Sprintf("工作区 %d 个条目", manifestCount)
	}
	return fmt.Sprintf(
		"%s | %.1f MB | 条目 %d | Bundle %d | Addressables %s | %s",
		scan.Name,
		float64(scan.SizeBytes)/1024/1024,
		scan.EntryCount,
		scan.Counts.UnityBundles,
		emptyDash(scan.Addressables.Version),
		manifestText,
	)
}

func (s *appState) tableCell(id widget.TableCellID) string {
	if s.isBundleResourceMode() {
		return s.bundleSummaryCell(id)
	}
	headers := []string{"路径", "类型", "大小", "CRC", "替换"}
	if id.Row == 0 {
		return headers[id.Col]
	}
	entry := s.filtered[id.Row-1]
	switch id.Col {
	case 0:
		return compactPath(entry.Path)
	case 1:
		return string(entry.Kind)
	case 2:
		return humanSize(entry.Size)
	case 3:
		return entry.CRC
	case 4:
		if entry.Changed {
			return "是"
		}
		return ""
	default:
		return ""
	}
}

func (s *appState) bundleSummaryCell(id widget.TableCellID) string {
	headers := []string{"Bundle资源", "类型", "大小", "Bundle", "替换"}
	if id.Row == 0 {
		return headers[id.Col]
	}
	item := s.bundleResources[id.Row-1]
	switch id.Col {
	case 0:
		return compactPath(item.Resource.Name)
	case 1:
		return item.Resource.Kind + "/" + item.Resource.Type
	case 2:
		return humanSize(item.Resource.Size)
	case 3:
		return compactPath(item.BundlePath)
	case 4:
		if item.Resource.Changed || item.Entry.Changed {
			return "是"
		}
		return ""
	default:
		return ""
	}
}

func bundleInfoText(entry apk.Entry, info bundle.Info, extracted bool) string {
	state := "未解包"
	if extracted {
		state = "已解包"
	}
	return fmt.Sprintf(
		"Unity Bundle\n路径: %s\n格式: %s v%d | Unity %s\n压缩: %s | Block %d | 节点 %d | 资源 %d | 状态: %s",
		entry.Path,
		info.Signature,
		info.FormatVersion,
		emptyDash(info.EngineVersion),
		info.Compression,
		info.BlockCount,
		info.NodeCount,
		info.ResourceCount,
		state,
	)
}

func bundleResourceCell(resources []bundle.Resource, id widget.TableCellID) string {
	headers := []string{"资源", "类型", "类别", "大小", "替换"}
	if id.Row == 0 {
		return headers[id.Col]
	}
	resource := resources[id.Row-1]
	switch id.Col {
	case 0:
		return compactPath(resource.Name)
	case 1:
		return resource.Type
	case 2:
		return resource.Kind
	case 3:
		return humanSize(resource.Size)
	case 4:
		if resource.Changed {
			return "是"
		}
		return ""
	default:
		return ""
	}
}

func bundleNodeCell(nodes []bundle.Node, id widget.TableCellID) string {
	headers := []string{"节点", "类型", "大小", "替换"}
	if id.Row == 0 {
		return headers[id.Col]
	}
	node := nodes[id.Row-1]
	switch id.Col {
	case 0:
		return compactPath(node.Path)
	case 1:
		return node.Kind
	case 2:
		return humanSize(node.Size)
	case 3:
		if node.Changed {
			return "是"
		}
		return ""
	default:
		return ""
	}
}

func (s *appState) groupLabel(group filterGroup) string {
	count := 0
	if s.project != nil {
		if isBundleResourceGroup(group.ID) {
			if s.currentID == group.ID {
				count = len(s.bundleResources)
			} else {
				count = len(s.collectBundleResources("", bundleResourceKindForGroup(group.ID)))
			}
		} else {
			for _, entry := range s.project.Manifest.Entries {
				if entry.IsDir {
					continue
				}
				if group.Match == nil || group.Match(entry) {
					count++
				}
			}
		}
	}
	return fmt.Sprintf("%s  %d", group.Label, count)
}

func (s *appState) collectBundleResources(query string, kind string) []bundleResourceItem {
	if s.project == nil || len(s.project.Manifest.Entries) == 0 {
		return nil
	}
	items := make([]bundleResourceItem, 0)
	for _, entry := range s.project.Manifest.Entries {
		if entry.IsDir || entry.Kind != apk.KindBundle {
			continue
		}
		manifest, err := s.project.LoadBundleManifest(entry.Path)
		if err != nil {
			continue
		}
		for _, resource := range manifest.Resources {
			if !bundleKindMatches(kind, resource.Kind) {
				continue
			}
			if query != "" && !bundleResourceMatches(query, entry.Path, resource) {
				continue
			}
			items = append(items, bundleResourceItem{
				BundlePath: entry.Path,
				Entry:      entry,
				Resource:   resource,
			})
		}
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].BundlePath == items[j].BundlePath {
			return items[i].Resource.Name < items[j].Resource.Name
		}
		return items[i].BundlePath < items[j].BundlePath
	})
	return items
}

func bundleResourceMatches(query string, bundlePath string, resource bundle.Resource) bool {
	values := []string{
		bundlePath,
		resource.ID,
		resource.Name,
		resource.Type,
		resource.FileName,
		resource.NodePath,
		resource.Details,
	}
	for _, value := range values {
		if strings.Contains(strings.ToLower(value), query) {
			return true
		}
	}
	return false
}

func isBundleResourceGroup(id string) bool {
	switch id {
	case bundleResourcesGroupID, bundleImagesGroupID, bundleTextsGroupID, bundleAudioGroupID, bundleOtherGroupID:
		return true
	default:
		return false
	}
}

func (s *appState) currentBundleResourceKind() string {
	return bundleResourceKindForGroup(s.currentID)
}

func bundleResourceKindForGroup(id string) string {
	switch id {
	case bundleImagesGroupID:
		return "image"
	case bundleTextsGroupID:
		return "text"
	case bundleAudioGroupID:
		return "audio"
	case bundleOtherGroupID:
		return "other"
	default:
		return ""
	}
}

func bundleKindMatches(filter string, kind string) bool {
	switch filter {
	case "":
		return true
	case "other":
		return kind != "image" && kind != "text" && kind != "audio"
	default:
		return kind == filter
	}
}

func failureSummary(failures []string) string {
	if len(failures) == 0 {
		return ""
	}
	limit := len(failures)
	if limit > 12 {
		limit = 12
	}
	text := strings.Join(failures[:limit], "\n")
	if len(failures) > limit {
		text += fmt.Sprintf("\n... 其余 %d 个失败请逐个 Bundle 重试。", len(failures)-limit)
	}
	return text
}

func (s *appState) currentGroup() filterGroup {
	for _, group := range s.groups {
		if group.ID == s.currentID {
			return group
		}
	}
	return s.groups[0]
}

func (s *appState) isBundleResourceMode() bool {
	return isBundleResourceGroup(s.currentID)
}

func (s *appState) configureTableColumns() {
	if s.table == nil {
		return
	}
	if s.isBundleResourceMode() {
		s.table.SetColumnWidth(0, 220)
		s.table.SetColumnWidth(1, 112)
		s.table.SetColumnWidth(2, 74)
		s.table.SetColumnWidth(3, 260)
		s.table.SetColumnWidth(4, 48)
		return
	}
	s.table.SetColumnWidth(0, 320)
	s.table.SetColumnWidth(1, 84)
	s.table.SetColumnWidth(2, 74)
	s.table.SetColumnWidth(3, 76)
	s.table.SetColumnWidth(4, 48)
}

func (s *appState) selectedEntry() (apk.Entry, bool) {
	for _, entry := range s.filtered {
		if entry.Path == s.selected {
			return entry, true
		}
	}
	return s.entryByPath(s.selected)
}

func (s *appState) entryByPath(path string) (apk.Entry, bool) {
	if s.project == nil {
		return apk.Entry{}, false
	}
	for _, entry := range s.project.Manifest.Entries {
		if entry.Path == path {
			return entry, true
		}
	}
	return apk.Entry{}, false
}

func (s *appState) hasProject() bool {
	if s.project != nil {
		return true
	}
	dialog.ShowInformation("未加载 APK", "请先选择 APK 文件。", s.window)
	return false
}

func (s *appState) hasManifest() bool {
	if !s.hasProject() {
		return false
	}
	if len(s.project.Manifest.Entries) > 0 {
		return true
	}
	dialog.ShowInformation("未解包", "请先解包 APK。", s.window)
	return false
}

func (s *appState) showError(title string, err error) {
	dialog.ShowError(fmt.Errorf("%s: %w", title, err), s.window)
}

func (s *appState) log(format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	line = fmt.Sprintf("[%s] %s", time.Now().Format("15:04:05"), line)
	if s.logEntry == nil {
		return
	}
	if strings.TrimSpace(s.logEntry.Text) == "" {
		s.logEntry.SetText(line)
		return
	}
	s.logEntry.SetText(s.logEntry.Text + "\n" + line)
}

func (s *appState) openPath(path string) {
	if err := os.MkdirAll(path, 0o755); err != nil {
		s.showError("打开目录失败", err)
		return
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		s.showError("打开目录失败", err)
		return
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", abs)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", "", abs)
	default:
		cmd = exec.Command("xdg-open", abs)
	}
	if err := cmd.Start(); err != nil {
		s.showError("打开目录失败", err)
	}
}

func defaultGroups() []filterGroup {
	return []filterGroup{
		{ID: "all", Label: "全部"},
		{ID: "assets", Label: "assets", Match: prefixMatch("assets/")},
		{ID: "res", Label: "res", Match: prefixMatch("res/")},
		{ID: "lib", Label: "lib", Match: prefixMatch("lib/")},
		{ID: "classes", Label: "classes", Match: func(entry apk.Entry) bool { return strings.HasSuffix(entry.Path, ".dex") }},
		{ID: "meta", Label: "META-INF", Match: prefixMatch("META-INF/")},
		{ID: "images", Label: "图片", Match: kindMatch(apk.KindImage)},
		{ID: "texts", Label: "文本", Match: kindMatch(apk.KindText)},
		{ID: "bundles", Label: "Bundle", Match: kindMatch(apk.KindBundle)},
		{ID: bundleResourcesGroupID, Label: "Bundle资源"},
		{ID: bundleImagesGroupID, Label: "Bundle图片"},
		{ID: bundleTextsGroupID, Label: "Bundle文本"},
		{ID: bundleAudioGroupID, Label: "Bundle音频"},
		{ID: bundleOtherGroupID, Label: "Bundle其他"},
		{ID: "changed", Label: "已替换", Match: func(entry apk.Entry) bool { return entry.Changed }},
	}
}

func prefixMatch(prefix string) func(apk.Entry) bool {
	return func(entry apk.Entry) bool {
		return strings.HasPrefix(entry.Path, prefix)
	}
}

func kindMatch(kind apk.EntryKind) func(apk.Entry) bool {
	return func(entry apk.Entry) bool {
		return entry.Kind == kind
	}
}

func centerLabel(text string) fyne.CanvasObject {
	label := widget.NewLabel(text)
	label.Alignment = fyne.TextAlignCenter
	label.Wrapping = fyne.TextWrapWord
	return container.NewCenter(label)
}

func nodePreviewText(path string, node bundle.Node) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	head := make([]byte, 64)
	n, err := file.Read(head)
	if err != nil && err != io.EOF {
		return "", err
	}
	info, err := file.Stat()
	if err != nil {
		return "", err
	}
	return fmt.Sprintf(
		"路径: %s\n类型: %s\n大小: %s\nCRC: %s\n前 64 字节:\n%s",
		node.Path,
		node.Kind,
		humanSize(info.Size()),
		emptyDash(node.CRC),
		hex.Dump(head[:n]),
	), nil
}

func looksTextual(data []byte) bool {
	if len(data) == 0 {
		return true
	}
	limit := len(data)
	if limit > 4096 {
		limit = 4096
	}
	for _, b := range data[:limit] {
		if b == 0 {
			return false
		}
		if b < 0x09 {
			return false
		}
		if b > 0x0d && b < 0x20 {
			return false
		}
	}
	return true
}

func hexDumpLimit(data []byte, limit int) string {
	if limit <= 0 || len(data) == 0 {
		return ""
	}
	if len(data) > limit {
		return hex.Dump(data[:limit]) + fmt.Sprintf("\n... 已截断，完整大小 %s ...", humanSize(int64(len(data))))
	}
	return hex.Dump(data)
}

func humanSize(size int64) string {
	if size < 1024 {
		return fmt.Sprintf("%d B", size)
	}
	units := []string{"KB", "MB", "GB"}
	value := float64(size)
	for _, unit := range units {
		value /= 1024
		if value < 1024 {
			return fmt.Sprintf("%.1f %s", value, unit)
		}
	}
	return fmt.Sprintf("%.1f TB", value/1024)
}

func emptyDash(value string) string {
	if value == "" {
		return "-"
	}
	return value
}

func compactPath(path string) string {
	if len(path) <= 64 {
		return path
	}
	parts := strings.Split(path, "/")
	if len(parts) <= 2 {
		return "..." + path[len(path)-61:]
	}
	head := parts[0]
	tail := strings.Join(parts[len(parts)-2:], "/")
	out := head + "/.../" + tail
	if len(out) <= 64 {
		return out
	}
	if len(tail) > 52 {
		tail = "..." + tail[len(tail)-49:]
	}
	return head + "/.../" + tail
}

func shortToolStatusText() string {
	status := apk.ToolStatus()
	signText := "签名可用"
	if !status["keytool"] || !status["zipalign"] || !status["apksigner"] {
		signText = "签名不可用"
	}
	extra := "增强工具: 无"
	if status["apktool"] || status["jadx"] {
		var tools []string
		if status["apktool"] {
			tools = append(tools, "apktool")
		}
		if status["jadx"] {
			tools = append(tools, "jadx")
		}
		extra = "增强工具: " + strings.Join(tools, "/")
	}
	return signText + " | " + extra
}

func uriPath(uri fyne.URI) string {
	if uri == nil {
		return ""
	}
	path := uri.Path()
	if decoded, err := url.PathUnescape(path); err == nil {
		return decoded
	}
	return path
}
