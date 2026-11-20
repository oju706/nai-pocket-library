//go:build windows && amd64

package main

import (
	"errors"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	swShowNormal    = 1
	swShowMaximized = 3
	swRestore       = 9
	swpNoZOrder     = 0x0004
	swpNoActivate   = 0x0010
	compactWindowW  = 460
	compactWindowH  = 360

	desktopWindowClass        = "Chrome_WidgetWin_1"
	desktopWindowTitlePrefix  = " [nai-window:"
	desktopWindowTitleSuffix  = "]"
	desktopWindowPollInterval = 250 * time.Millisecond
	desktopWindowCloseGrace   = 2 * time.Second
	desktopWindowReopenGrace  = 8 * time.Second
)

var (
	user32                  = syscall.NewLazyDLL("user32.dll")
	procEnumWindows         = user32.NewProc("EnumWindows")
	procGetForegroundWindow = user32.NewProc("GetForegroundWindow")
	procIsWindowVisible     = user32.NewProc("IsWindowVisible")
	procGetWindowPlacement  = user32.NewProc("GetWindowPlacement")
	procSetWindowPlacement  = user32.NewProc("SetWindowPlacement")
	procGetWindowRect       = user32.NewProc("GetWindowRect")
	procShowWindow          = user32.NewProc("ShowWindow")
	procSetWindowPos        = user32.NewProc("SetWindowPos")
	procGetClassName        = user32.NewProc("GetClassNameW")
	procGetWindowText       = user32.NewProc("GetWindowTextW")
	procGetDPIForWindow     = user32.NewProc("GetDpiForWindow")
	procSetThreadDPIContext = user32.NewProc("SetThreadDpiAwarenessContext")
	procMonitorFromWindow   = user32.NewProc("MonitorFromWindow")
	procGetMonitorInfo      = user32.NewProc("GetMonitorInfoW")

	windowScanMu      sync.Mutex
	windowScanMarker  string
	windowScanMatches map[syscall.Handle]struct{}
	enumWindowProc    = syscall.NewCallback(collectDesktopWindow)
)

type point struct {
	x int32
	y int32
}

type rect struct {
	left   int32
	top    int32
	right  int32
	bottom int32
}

type windowPlacement struct {
	length         uint32
	flags          uint32
	showCmd        uint32
	minPosition    point
	maxPosition    point
	normalPosition rect
}

type monitorInfo struct {
	length uint32
	area   rect
	work   rect
	flags  uint32
}

type desktopWindow struct {
	mu sync.Mutex

	marker      string
	hwnd        syscall.Handle
	compact     bool
	closing     bool
	reopenUntil time.Time

	savedPlacement windowPlacement
	savedHWND      syscall.Handle
}

func (w *desktopWindow) setMarker(marker string) error {
	if marker != "" && !validDesktopWindowMarker(marker) {
		return errors.New("窗口标记格式无效")
	}
	w.mu.Lock()
	defer w.mu.Unlock()

	w.marker = marker
	w.hwnd = 0
	w.compact = false
	w.closing = false
	w.reopenUntil = time.Time{}
	w.savedPlacement = windowPlacement{}
	w.savedHWND = 0
	return nil
}

func (w *desktopWindow) markerValue() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.marker
}

func (w *desktopWindow) expectReopen() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closing {
		return false
	}
	if w.marker != "" {
		w.reopenUntil = time.Now().Add(desktopWindowReopenGrace)
	}
	return true
}

func (w *desktopWindow) closeAfterWindowLoss(now time.Time) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if now.Before(w.reopenUntil) {
		return false
	}
	w.closing = true
	return true
}

func (w *desktopWindow) status() (enabled, compact bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return validDesktopWindowMarker(w.marker), w.compact
}

func (w *desktopWindow) folderPickerOwner() uintptr {
	marker, preferred := w.windowState()
	matches, err := matchingDesktopWindows(marker)
	if err != nil {
		return 0
	}
	return uintptr(selectDesktopWindow(matches, preferred))
}

func (w *desktopWindow) setCompact(compact bool) error {
	w.mu.Lock()
	defer w.mu.Unlock()

	if !validDesktopWindowMarker(w.marker) {
		return errors.New("当前没有可控的应用窗口。")
	}
	if w.compact == compact {
		return nil
	}

	matches, err := matchingDesktopWindows(w.marker)
	if err != nil {
		return err
	}
	hwnd := selectDesktopWindow(matches, w.hwnd)
	if hwnd == 0 {
		return errors.New("当前没有可控的应用窗口。")
	}
	// Use the monitor's physical coordinates for both the window and work area.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if procSetThreadDPIContext.Find() == nil {
		const perMonitorV2 = ^uintptr(3)
		if previous, _, _ := procSetThreadDPIContext.Call(perMonitorV2); previous != 0 {
			defer procSetThreadDPIContext.Call(previous)
		}
	}

	if compact {
		return w.compactTargetWindow(hwnd)
	}
	return w.expandTargetWindow(hwnd)
}

func (w *desktopWindow) windowState() (string, syscall.Handle) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.marker, w.hwnd
}

func desktopWindowTitleMarker(marker string) string {
	return desktopWindowTitlePrefix + marker + desktopWindowTitleSuffix
}

func collectDesktopWindow(hwnd, _ uintptr) uintptr {
	marker := windowScanMarker
	if marker == "" {
		return 1
	}
	if visible, _, _ := procIsWindowVisible.Call(hwnd); visible == 0 {
		return 1
	}
	var class [128]uint16
	classLen, _, _ := procGetClassName.Call(hwnd, uintptr(unsafe.Pointer(&class[0])), uintptr(len(class)))
	if classLen == 0 || syscall.UTF16ToString(class[:classLen]) != desktopWindowClass {
		return 1
	}
	var caption [1024]uint16
	captionLen, _, _ := procGetWindowText.Call(hwnd, uintptr(unsafe.Pointer(&caption[0])), uintptr(len(caption)))
	if captionLen == 0 {
		return 1
	}
	title := syscall.UTF16ToString(caption[:captionLen])
	if strings.HasPrefix(title, "NAI 口袋词库") && strings.Contains(title, desktopWindowTitleMarker(marker)) {
		windowScanMatches[syscall.Handle(hwnd)] = struct{}{}
	}
	return 1
}

func matchingDesktopWindows(marker string) ([]syscall.Handle, error) {
	if !validDesktopWindowMarker(marker) {
		return nil, errors.New("当前没有可控的应用窗口。")
	}
	windowScanMu.Lock()
	defer windowScanMu.Unlock()

	windowScanMarker = marker
	windowScanMatches = make(map[syscall.Handle]struct{})
	ok, _, callErr := procEnumWindows.Call(enumWindowProc, 0)
	windowScanMarker = ""
	if ok == 0 {
		return nil, fmt.Errorf("EnumWindows: %w", callErr)
	}
	matches := make([]syscall.Handle, 0, len(windowScanMatches))
	for hwnd := range windowScanMatches {
		matches = append(matches, hwnd)
	}
	windowScanMatches = nil
	return matches, nil
}

func selectDesktopWindow(matches []syscall.Handle, preferred syscall.Handle) syscall.Handle {
	if foreground, _, _ := procGetForegroundWindow.Call(); foreground != 0 {
		for _, hwnd := range matches {
			if uintptr(hwnd) == foreground {
				return hwnd
			}
		}
	}
	for _, hwnd := range matches {
		if hwnd == preferred {
			return hwnd
		}
	}
	if len(matches) != 0 {
		return matches[0]
	}
	return 0
}

func (w *desktopWindow) trackWindows() <-chan struct{} {
	marker := w.markerValue()
	if !validDesktopWindowMarker(marker) {
		return nil
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(desktopWindowPollInterval)
		defer ticker.Stop()

		seen := false
		var absentSince time.Time
		for {
			matches, err := matchingDesktopWindows(marker)
			now := time.Now()
			if err != nil {
				absentSince = time.Time{}
			} else if len(matches) != 0 {
				seen = true
				absentSince = time.Time{}
				w.rememberWindow(matches)
			} else if seen {
				if absentSince.IsZero() {
					absentSince = now
				} else if now.Sub(absentSince) >= desktopWindowCloseGrace && w.closeAfterWindowLoss(now) {
					return
				}
			}
			<-ticker.C
		}
	}()
	return done
}

func (w *desktopWindow) rememberWindow(matches []syscall.Handle) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, hwnd := range matches {
		if hwnd == w.hwnd {
			return
		}
	}
	if len(matches) == 0 {
		return
	}
	if w.compact {
		w.compact = false
		w.savedPlacement = windowPlacement{}
		w.savedHWND = 0
	}
	w.hwnd = matches[0]
}

func (w *desktopWindow) compactTargetWindow(hwnd syscall.Handle) error {
	placement := windowPlacement{length: uint32(unsafe.Sizeof(windowPlacement{}))}
	if err := getWindowPlacement(hwnd, &placement); err != nil {
		return err
	}
	if placement.showCmd != swShowNormal && placement.showCmd != swShowMaximized {
		return errors.New("当前窗口状态无法折叠，请先还原窗口。")
	}

	var current rect
	if err := getWindowRect(hwnd, &current); err != nil {
		return err
	}

	dpi := uintptr(96)
	if procGetDPIForWindow.Find() == nil {
		if measured, _, _ := procGetDPIForWindow.Call(uintptr(hwnd)); measured > 0 {
			dpi = measured
		}
	}
	width := int32(compactWindowW * dpi / 96)
	height := int32(compactWindowH * dpi / 96)
	left, top := current.left, current.top
	monitor, _, _ := procMonitorFromWindow.Call(uintptr(hwnd), 2) // MONITOR_DEFAULTTONEAREST
	info := monitorInfo{length: uint32(unsafe.Sizeof(monitorInfo{}))}
	if found, _, _ := procGetMonitorInfo.Call(monitor, uintptr(unsafe.Pointer(&info))); found != 0 {
		left = max(info.work.left, min(left, info.work.right-width))
		top = max(info.work.top, min(top, info.work.bottom-height))
	}

	if placement.showCmd == swShowMaximized {
		procShowWindow.Call(uintptr(hwnd), swRestore)
	}
	ok, _, callErr := procSetWindowPos.Call(
		uintptr(hwnd),
		0,
		uintptr(int(left)),
		uintptr(int(top)),
		uintptr(width),
		uintptr(height),
		swpNoZOrder|swpNoActivate,
	)
	if ok != 0 {
		w.hwnd = hwnd
		w.compact = true
		w.savedPlacement = placement
		w.savedHWND = hwnd
		return nil
	}

	if err := setWindowPlacement(hwnd, &placement); err != nil {
		return fmt.Errorf("无法折叠窗口或恢复窗口位置：%v（%v）", callErr, err)
	}
	return fmt.Errorf("无法折叠窗口：%w", callErr)
}

func (w *desktopWindow) expandTargetWindow(hwnd syscall.Handle) error {
	if w.savedHWND != hwnd {
		return errors.New("请先切回原来的已折叠窗口。")
	}

	placement := w.savedPlacement
	if err := setWindowPlacement(hwnd, &placement); err != nil {
		return err
	}

	w.compact = false
	w.savedPlacement = windowPlacement{}
	w.savedHWND = 0
	return nil
}

func getWindowPlacement(hwnd syscall.Handle, placement *windowPlacement) error {
	placement.length = uint32(unsafe.Sizeof(*placement))
	ok, _, callErr := procGetWindowPlacement.Call(
		uintptr(hwnd),
		uintptr(unsafe.Pointer(placement)),
	)
	if ok == 0 {
		return fmt.Errorf("GetWindowPlacement: %w", callErr)
	}
	return nil
}

func setWindowPlacement(hwnd syscall.Handle, placement *windowPlacement) error {
	placement.length = uint32(unsafe.Sizeof(*placement))
	ok, _, callErr := procSetWindowPlacement.Call(
		uintptr(hwnd),
		uintptr(unsafe.Pointer(placement)),
	)
	if ok == 0 {
		return fmt.Errorf("SetWindowPlacement: %w", callErr)
	}
	return nil
}

func getWindowRect(hwnd syscall.Handle, windowRect *rect) error {
	ok, _, callErr := procGetWindowRect.Call(
		uintptr(hwnd),
		uintptr(unsafe.Pointer(windowRect)),
	)
	if ok == 0 {
		return fmt.Errorf("GetWindowRect: %w", callErr)
	}
	return nil
}
