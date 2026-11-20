//go:build windows && amd64

package main

import (
	"fmt"
	"runtime"
	"syscall"
	"unsafe"
)

const (
	browseInfoReturnOnlyFSPaths = 0x00000001
	browseInfoUseNewUI          = 0x00000050 // BIF_EDITBOX | BIF_NEWDIALOGSTYLE
	coInitApartmentThreaded     = 0x00000002
	coInitDisableOLE1DDE        = 0x00000004
	browseDisplayNameChars      = 260
	pickedPathChars             = 32768
)

// BROWSEINFOW is 64 bytes in the Windows x64 ABI. The padding fields make
// the three naturally aligned pointer-sized members explicit.
type browseInfoW struct {
	hwndOwner      uintptr
	pidlRoot       uintptr
	pszDisplayName *uint16
	lpszTitle      *uint16
	ulFlags        uint32
	_              uint32
	lpfn           uintptr
	lParam         uintptr
	iImage         int32
	_              uint32
}

func pickRememberedGalleryFolder(owner uintptr) (string, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	loadProc := func(dllName, procName string) (*syscall.LazyProc, error) {
		proc := syscall.NewLazyDLL(dllName).NewProc(procName)
		if err := proc.Find(); err != nil {
			return nil, fmt.Errorf("加载 Windows 系统接口 %s 失败: %w", procName, err)
		}
		return proc, nil
	}

	coInitializeEx, err := loadProc("ole32.dll", "CoInitializeEx")
	if err != nil {
		return "", err
	}
	coUninitialize, err := loadProc("ole32.dll", "CoUninitialize")
	if err != nil {
		return "", err
	}
	coTaskMemFree, err := loadProc("ole32.dll", "CoTaskMemFree")
	if err != nil {
		return "", err
	}
	shellBrowseForFolder, err := loadProc("shell32.dll", "SHBrowseForFolderW")
	if err != nil {
		return "", err
	}
	shellGetPathFromIDList, err := loadProc("shell32.dll", "SHGetPathFromIDListEx")
	if err != nil {
		return "", err
	}

	result, _, _ := coInitializeEx.Call(0, uintptr(coInitApartmentThreaded|coInitDisableOLE1DDE))
	if int32(result) < 0 {
		return "", fmt.Errorf("初始化 COM STA 失败（HRESULT 0x%08X）", uint32(result))
	}
	defer coUninitialize.Call()

	title, err := syscall.UTF16PtrFromString("选择图片文件夹")
	if err != nil {
		return "", fmt.Errorf("创建目录选择器标题失败: %w", err)
	}
	var displayName [browseDisplayNameChars]uint16
	browseInfo := browseInfoW{
		hwndOwner:      owner,
		pszDisplayName: &displayName[0],
		lpszTitle:      title,
		ulFlags:        browseInfoReturnOnlyFSPaths | browseInfoUseNewUI,
	}

	pidl, _, _ := shellBrowseForFolder.Call(uintptr(unsafe.Pointer(&browseInfo)))
	runtime.KeepAlive(title)
	runtime.KeepAlive(&displayName)
	if pidl == 0 {
		return "", nil
	}
	defer coTaskMemFree.Call(pidl)

	pathBuffer := make([]uint16, pickedPathChars)
	pathOK, _, _ := shellGetPathFromIDList.Call(
		pidl,
		uintptr(unsafe.Pointer(&pathBuffer[0])),
		uintptr(len(pathBuffer)),
		0,
	)
	if pathOK == 0 {
		return "", fmt.Errorf("无法读取所选文件夹的路径")
	}
	path := syscall.UTF16ToString(pathBuffer)
	if path == "" {
		return "", fmt.Errorf("目录选择器返回了空路径")
	}

	return path, nil
}
