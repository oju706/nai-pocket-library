//go:build windows && amd64

package main

import (
	"errors"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"syscall"
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
)

var (
	user32                       = syscall.NewLazyDLL("user32.dll")
	procGetForegroundWindow      = user32.NewProc("GetForegroundWindow")
	procGetWindowThreadProcessID = user32.NewProc("GetWindowThreadProcessId")
	procGetWindowPlacement       = user32.NewProc("GetWindowPlacement")
	procSetWindowPlacement       = user32.NewProc("SetWindowPlacement")
	procGetWindowRect            = user32.NewProc("GetWindowRect")
	procShowWindow               = user32.NewProc("ShowWindow")
	procSetWindowPos             = user32.NewProc("SetWindowPos")
	procGetClassName             = user32.NewProc("GetClassNameW")
	procGetWindowText            = user32.NewProc("GetWindowTextW")
	procGetDPIForWindow          = user32.NewProc("GetDpiForWindow")
	procSetThreadDPIContext      = user32.NewProc("SetThreadDpiAwarenessContext")
	procMonitorFromWindow        = user32.NewProc("MonitorFromWindow")
	procGetMonitorInfo           = user32.NewProc("GetMonitorInfoW")
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

	pid     int
	compact bool

	savedPlacement windowPlacement
	savedHWND      syscall.Handle
}

func (w *desktopWindow) setPID(pid int) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.pid == pid {
		return
	}
	w.pid = pid
	w.compact = false
	w.savedPlacement = windowPlacement{}
	w.savedHWND = 0
}

func (w *desktopWindow) status() (enabled, compact bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.pid > 0, w.compact
}

func (w *desktopWindow) folderPickerOwner() uintptr {
	w.mu.Lock()
	defer w.mu.Unlock()
	hwnd, _ := foregroundWindowForPID(w.pid)
	return uintptr(hwnd)
}

func (w *desktopWindow) setCompact(compact bool) error {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.pid <= 0 {
		return errors.New("当前没有可控的应用窗口。")
	}
	if w.compact == compact {
		return nil
	}

	hwnd, err := foregroundWindowForPID(w.pid)
	if err != nil {
		return err
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
		return w.compactForegroundWindow(hwnd)
	}
	return w.expandForegroundWindow(hwnd)
}

func foregroundWindowForPID(pid int) (syscall.Handle, error) {
	hwnd, _, _ := procGetForegroundWindow.Call()
	if hwnd == 0 {
		return 0, errors.New("请先切回 NAI 口袋词库的独立窗口。")
	}

	var windowPID uint32
	threadID, _, _ := procGetWindowThreadProcessID.Call(
		hwnd,
		uintptr(unsafe.Pointer(&windowPID)),
	)
	if threadID == 0 || windowPID != uint32(pid) {
		return 0, errors.New("请先切回 NAI 口袋词库的独立窗口。")
	}
	var caption [256]uint16
	classLen, _, _ := procGetClassName.Call(hwnd, uintptr(unsafe.Pointer(&caption[0])), uintptr(len(caption)))
	if classLen == 0 || syscall.UTF16ToString(caption[:classLen]) != "Chrome_WidgetWin_1" {
		return 0, errors.New("请先切回 NAI 口袋词库的独立窗口。")
	}
	captionLen, _, _ := procGetWindowText.Call(hwnd, uintptr(unsafe.Pointer(&caption[0])), uintptr(len(caption)))
	if captionLen == 0 || !strings.HasPrefix(syscall.UTF16ToString(caption[:captionLen]), "NAI 口袋词库") {
		return 0, errors.New("请先切回 NAI 口袋词库的独立窗口。")
	}
	return syscall.Handle(hwnd), nil
}

func (w *desktopWindow) compactForegroundWindow(hwnd syscall.Handle) error {
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

func (w *desktopWindow) expandForegroundWindow(hwnd syscall.Handle) error {
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
