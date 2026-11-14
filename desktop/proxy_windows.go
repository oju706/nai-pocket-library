//go:build windows

package main

import (
	"encoding/binary"
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"syscall"
	"unsafe"
)

const (
	desktopInternetSettingsKey = `Software\Microsoft\Windows\CurrentVersion\Internet Settings`
	desktopMaxRegistryValue    = 1 << 20
)

var errDesktopProxySetting = errors.New("Windows 静态代理设置格式无效")

// desktopUpstreamProxy returns the proxy for an upstream HTTP request.
// Loopback traffic is always direct. Environment proxy settings take
// precedence over the current user's static Windows proxy settings.
func desktopUpstreamProxy(req *http.Request) (*url.URL, error) {
	if req == nil || req.URL == nil {
		return nil, nil
	}
	scheme := strings.ToLower(req.URL.Scheme)
	host := req.URL.Hostname()
	if (scheme != "http" && scheme != "https") || host == "" || desktopIsLoopback(host) {
		return nil, nil
	}

	proxy, err := http.ProxyFromEnvironment(req)
	if proxy != nil || err != nil {
		return proxy, err
	}
	if desktopEnvProxyConfigured(scheme) {
		// The environment configured this scheme, so ProxyFromEnvironment's
		// nil result means that NO_PROXY excluded it.
		return nil, nil
	}
	if desktopProxyOverrideMatches(host, desktopEnv("NO_PROXY", "no_proxy")) {
		return nil, nil
	}
	return desktopWindowsStaticProxy(scheme, host)
}

func desktopEnvProxyConfigured(scheme string) bool {
	if scheme == "https" {
		return desktopEnv("HTTPS_PROXY", "https_proxy") != ""
	}
	return desktopEnv("HTTP_PROXY", "http_proxy") != ""
}

func desktopEnv(upper, lower string) string {
	if value := os.Getenv(upper); value != "" {
		return value
	}
	return os.Getenv(lower)
}

func desktopIsLoopback(host string) bool {
	host = strings.TrimSuffix(host, ".")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func desktopWindowsStaticProxy(scheme, host string) (*url.URL, error) {
	keyName, err := syscall.UTF16PtrFromString(desktopInternetSettingsKey)
	if err != nil {
		return nil, err
	}
	var key syscall.Handle
	err = syscall.RegOpenKeyEx(
		syscall.HKEY_CURRENT_USER,
		keyName,
		0,
		syscall.KEY_QUERY_VALUE,
		&key,
	)
	if desktopRegistryValueMissing(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer syscall.RegCloseKey(key)

	enabled, err := desktopRegistryDWORD(key, "ProxyEnable")
	if desktopRegistryValueMissing(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if enabled == 0 {
		return nil, nil
	}

	server, err := desktopRegistryString(key, "ProxyServer")
	if desktopRegistryValueMissing(err) || (err == nil && strings.TrimSpace(server) == "") {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	override, err := desktopRegistryString(key, "ProxyOverride")
	if desktopRegistryValueMissing(err) {
		override, err = "", nil
	}
	if err != nil {
		return nil, err
	}
	if desktopProxyOverrideMatches(host, override) {
		return nil, nil
	}
	endpoint, ok := desktopProxyForScheme(server, scheme)
	if !ok {
		return nil, nil
	}
	return desktopParseProxyURL(endpoint)
}

func desktopProxyForScheme(settings, scheme string) (string, bool) {
	hasProtocolEntry := false
	for _, part := range strings.Split(settings, ";") {
		name, value, ok := strings.Cut(part, "=")
		if !ok || !strings.EqualFold(strings.TrimSpace(name), "http") && !strings.EqualFold(strings.TrimSpace(name), "https") {
			continue
		}
		hasProtocolEntry = true
		if strings.EqualFold(strings.TrimSpace(name), scheme) {
			value = strings.TrimSpace(value)
			return value, value != ""
		}
	}
	if hasProtocolEntry {
		return "", false
	}
	settings = strings.TrimSpace(settings)
	return settings, settings != ""
}

func desktopParseProxyURL(endpoint string) (*url.URL, error) {
	endpoint = strings.TrimSpace(endpoint)
	if !strings.Contains(endpoint, "://") {
		endpoint = "http://" + endpoint
	}
	proxy, err := url.Parse(endpoint)
	if err != nil || proxy.Host == "" ||
		(!strings.EqualFold(proxy.Scheme, "http") && !strings.EqualFold(proxy.Scheme, "https")) {
		return nil, errDesktopProxySetting
	}
	proxy.Scheme = strings.ToLower(proxy.Scheme)
	return proxy, nil
}

func desktopProxyOverrideMatches(host, overrides string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	for _, override := range strings.FieldsFunc(overrides, func(r rune) bool {
		return r == ',' || r == ';'
	}) {
		pattern := strings.ToLower(strings.TrimSpace(override))
		if pattern == "" {
			continue
		}
		if pattern == "*" {
			return true
		}
		if pattern == "<local>" {
			if !strings.Contains(host, ".") {
				return true
			}
			continue
		}

		pattern = desktopProxyPatternHost(pattern)
		if _, network, err := net.ParseCIDR(pattern); err == nil {
			if ip := net.ParseIP(host); ip != nil && network.Contains(ip) {
				return true
			}
			continue
		}
		if ip := net.ParseIP(pattern); ip != nil {
			if target := net.ParseIP(host); target != nil && ip.Equal(target) {
				return true
			}
			continue
		}
		if strings.HasPrefix(pattern, ".") {
			domain := strings.TrimPrefix(pattern, ".")
			if host == domain || strings.HasSuffix(host, "."+domain) {
				return true
			}
			continue
		}
		if matched, err := path.Match(pattern, host); err == nil && matched {
			return true
		}
	}
	return false
}

func desktopProxyPatternHost(pattern string) string {
	if strings.HasPrefix(pattern, "[") {
		if end := strings.IndexByte(pattern, ']'); end >= 0 {
			return strings.TrimSuffix(pattern[1:end], ".")
		}
	}
	if host, _, err := net.SplitHostPort(pattern); err == nil {
		return strings.TrimSuffix(host, ".")
	}
	return strings.TrimSuffix(pattern, ".")
}

func desktopRegistryDWORD(key syscall.Handle, name string) (uint32, error) {
	namePtr, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return 0, err
	}
	var valueType, size uint32
	if err := syscall.RegQueryValueEx(key, namePtr, nil, &valueType, nil, &size); err != nil {
		return 0, err
	}
	if valueType != syscall.REG_DWORD || size < 4 {
		return 0, errDesktopProxySetting
	}
	var data [4]byte
	size = uint32(len(data))
	if err := syscall.RegQueryValueEx(key, namePtr, nil, &valueType, &data[0], &size); err != nil {
		return 0, err
	}
	if valueType != syscall.REG_DWORD || size != uint32(len(data)) {
		return 0, errDesktopProxySetting
	}
	return binary.LittleEndian.Uint32(data[:]), nil
}

func desktopRegistryString(key syscall.Handle, name string) (string, error) {
	namePtr, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return "", err
	}
	var valueType, size uint32
	if err := syscall.RegQueryValueEx(key, namePtr, nil, &valueType, nil, &size); err != nil {
		return "", err
	}
	if valueType != syscall.REG_SZ {
		return "", errDesktopProxySetting
	}
	if size == 0 {
		return "", nil
	}
	if size%2 != 0 || size > desktopMaxRegistryValue {
		return "", errDesktopProxySetting
	}
	data := make([]uint16, size/2)
	got := uint32(len(data) * 2)
	if err := syscall.RegQueryValueEx(
		key,
		namePtr,
		nil,
		&valueType,
		(*byte)(unsafe.Pointer(&data[0])),
		&got,
	); err != nil {
		return "", err
	}
	if valueType != syscall.REG_SZ || got%2 != 0 || got > uint32(len(data)*2) {
		return "", errDesktopProxySetting
	}
	return syscall.UTF16ToString(data[:got/2]), nil
}

func desktopRegistryValueMissing(err error) bool {
	return err == syscall.ERROR_FILE_NOT_FOUND || err == syscall.ERROR_PATH_NOT_FOUND
}
