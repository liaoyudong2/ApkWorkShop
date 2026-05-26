package ui

import (
	"testing"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/test"
)

func TestMainLayoutMinimumSize(t *testing.T) {
	fyneApp := test.NewApp()
	defer fyneApp.Quit()

	window := fyneApp.NewWindow(appTitle)
	state := &appState{
		app:       fyneApp,
		window:    window,
		currentID: "all",
		groups:    defaultGroups(),
	}
	content := state.buildUI()
	size := content.MinSize()
	if size.Width > 960 {
		t.Fatalf("layout min width = %.1f, want <= 960", size.Width)
	}
	if size.Height > 680 {
		t.Fatalf("layout min height = %.1f, want <= 680", size.Height)
	}

	window.Resize(fyne.NewSize(960, 640))
	window.SetContent(content)
}
