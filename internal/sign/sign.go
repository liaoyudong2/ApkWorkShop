package sign

import (
	"fmt"
	"strings"

	"apkworkshop/internal/apk"
)

func StatusText() string {
	status := apk.ToolStatus()
	var parts []string
	for _, name := range []string{"keytool", "zipalign", "apksigner", "apktool", "jadx"} {
		state := "无"
		if status[name] {
			state = "有"
		}
		parts = append(parts, fmt.Sprintf("%s:%s", name, state))
	}
	if !status["zipalign"] || !status["apksigner"] {
		parts = append(parts, "签名不可用，可构建未签名 APK")
	}
	return strings.Join(parts, "  ")
}
