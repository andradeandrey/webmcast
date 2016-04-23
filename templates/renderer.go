package templates

import (
	"fmt"
	"github.com/oxtoacart/bpool"
	"html/template"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

type templateSet struct {
	root   string
	parsed *template.Template
	at     time.Time
}

func (ts *templateSet) Get(name string) (*template.Template, error) {
	stat, err := os.Stat(filepath.Join(ts.root, name))
	if ts.parsed == nil || (err == nil && stat.ModTime().After(ts.at)) {
		ts.parsed, err = template.ParseGlob(filepath.Join(ts.root, "*"))
		if err != nil {
			return nil, err
		}
		ts.at = time.Now()
	}
	if t := ts.parsed.Lookup(name); t != nil {
		return t, nil
	}
	return nil, fmt.Errorf("template not found: %s", name)
}

var bufpool = bpool.NewBufferPool(64)
var templates = templateSet{root: "templates"}

func Page(w http.ResponseWriter, code int, template string, data interface{}) error {
	tpl, err := templates.Get(template)
	if err != nil {
		return err
	}
	buf := bufpool.Get()
	defer bufpool.Put(buf)
	if err = tpl.Execute(buf, data); err != nil {
		return err
	}
	w.Header().Set("Content-Type", "text/html; encoding=utf-8")
	w.WriteHeader(code)
	buf.WriteTo(w)
	return nil
}

type errorViewModel struct {
	Code    int
	Message string
}

func (e errorViewModel) DisplayMessage() string {
	if e.Message != "" {
		return e.Message
	}

	switch e.Code {
	case 403:
		return "FOREBODEN."
	case 404:
		return "There is nothing here."
	case 405:
		return "Invalid HTTP method."
	case 418:
		return "I'm a little teapot."
	case 500:
		return "✋☠❄☜☼☠✌☹ 💧☜☼✞☜☼ ☜☼☼⚐☼"
	default:
		return "ERROR"
	}
}

func (e errorViewModel) DisplayComment() string {
	switch e.Code {
	case 403:
		return "you're just a dirty hacker, aren't you?"
	case 404:
		return "(The dog absorbs the page.)"
	case 418:
		return "Would you like a cup of tea?"
	case 500:
		return "Try submitting a bug report."
	default:
		return "Try something else."
	}
}

func Error(w http.ResponseWriter, code int, message string) error {
	w.Header().Set("Cache-Control", "no-cache")
	return Page(w, code, "error.html", errorViewModel{code, message})
}

func InvalidMethod(w http.ResponseWriter, methods string) error {
	w.Header().Set("Allow", methods)
	return Error(w, http.StatusMethodNotAllowed, "")
}
