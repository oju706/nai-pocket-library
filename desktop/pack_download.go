package main

import (
	"archive/zip"
	"bytes"
	"context"
	"net/http"
)

const (
	packDownloadCount = 20
	packDownloadLimit = 32 * 1024 * 1024
)

func (app *application) servePackDownload(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "private, no-store")
	query := request.URL.Query()
	mode, revision, ids := query.Get("mode"), query.Get("revision"), query["id"]
	if !packSHA256.MatchString(revision) || len(ids) < 1 || len(ids) > packDownloadCount {
		writeRouteFailure(writer, request, badRequest("请选择 1 至 20 张图。"))
		return
	}
	var readPhoto func(context.Context, string, string, bool) ([]byte, string, error)
	var countBytes func(string, string) int64
	switch mode {
	case "github":
		readPhoto, countBytes = app.onlinePacks.photo, app.onlinePacks.photoSize
	case "community":
		readPhoto, countBytes = app.community.photo, app.community.photoSize
	case "local":
		readPhoto, countBytes = app.localZip.photo, app.localZip.photoSize
	default:
		writeRouteFailure(writer, request, badRequest("图包来源无效。"))
		return
	}
	seen := make(map[string]bool, len(ids))
	var total int64
	for _, id := range ids {
		if !packIDPattern.MatchString(id) || seen[id] {
			writeRouteFailure(writer, request, badRequest("所选图片编号无效。"))
			return
		}
		seen[id] = true
		size := countBytes(revision, id)
		if size < 1 {
			writeRouteFailure(writer, request, notFound("图包目录已变化，请重新打开。"))
			return
		}
		total += size
	}
	if total > packDownloadLimit {
		writeRouteFailure(writer, request, badRequest("单批原图合计最多 32 MiB。"))
		return
	}
	if len(ids) == 1 {
		data, mime, err := readPhoto(request.Context(), revision, ids[0], false)
		if err != nil {
			writeRouteFailure(writer, request, err)
			return
		}
		writeBytes(writer, request, http.StatusOK, mime, data)
		return
	}
	var output bytes.Buffer
	output.Grow(int(total))
	archive := zip.NewWriter(&output)
	for _, id := range ids {
		data, mime, err := readPhoto(request.Context(), revision, id, false)
		if err != nil {
			writeRouteFailure(writer, request, err)
			return
		}
		entry, err := archive.CreateHeader(&zip.FileHeader{
			Name: id + packImageExtension(mime), Method: zip.Store,
		})
		if err == nil {
			_, err = entry.Write(data)
		}
		if err != nil {
			writeRouteFailure(writer, request, upstreamFailure("原图 ZIP 无法生成。"))
			return
		}
	}
	if err := archive.Close(); err != nil {
		writeRouteFailure(writer, request, upstreamFailure("原图 ZIP 无法生成。"))
		return
	}
	writeBytes(writer, request, http.StatusOK, "application/zip", output.Bytes())
}

func packImageExtension(mime string) string {
	switch mime {
	case "image/png":
		return ".png"
	case "image/jpeg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	default:
		return ".bin"
	}
}
