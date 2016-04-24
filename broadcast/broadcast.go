package broadcast

import (
	"errors"
	"sync"
	"time"
)

const (
	// a special value for a tag's length than means "until the next tag of same level".
	ebmlIndeterminate = 0xFFFFFFFFFFFFFF
	// some of the possible tag ids.
	// https://www.matroska.org/technical/specs/index.html
	ebmlTagVoid            = 0xEC
	ebmlTagEBML            = 0x1A45DFA3
	ebmlTagSegment         = 0x18538067
	ebmlTagSeekHead        = 0x114D9B74
	ebmlTagInfo            = 0x1549A966
	ebmlTagTimecodeScale   = 0x2AD7B1
	ebmlTagDuration        = 0x4489
	ebmlTagDateUTC         = 0x4461
	ebmlTagMuxingApp       = 0x4D80
	ebmlTagWritingApp      = 0x5741
	ebmlTagTracks          = 0x1654AE6B
	ebmlTagTrackEntry      = 0xAE
	ebmlTagTrackNumber     = 0xD7
	ebmlTagTrackUID        = 0x73C5
	ebmlTagTrackType       = 0x83
	ebmlTagFlagEnabled     = 0xB9
	ebmlTagFlagDefault     = 0x88
	ebmlTagFlagForced      = 0x55AA
	ebmlTagFlagLacing      = 0x9C
	ebmlTagDefaultDuration = 0x23E383
	ebmlTagName            = 0x536E
	ebmlTagCodecID         = 0x86
	ebmlTagCodecName       = 0x228688
	ebmlTagVideo           = 0xE0
	ebmlTagPixelWidth      = 0xB0
	ebmlTagPixelHeight     = 0xBA
	ebmlTagAudio           = 0xE1
	ebmlTagCluster         = 0x1F43B675
	ebmlTagTimecode        = 0xE7
	ebmlTagPrevSize        = 0xAB
	ebmlTagSimpleBlock     = 0xA3
	ebmlTagBlockGroup      = 0xA0
	ebmlTagBlock           = 0xA1
	ebmlTagBlockDuration   = 0x9B
	ebmlTagReferenceBlock  = 0xFB
	ebmlTagDiscardPadding  = 0x75A2
	ebmlTagCues            = 0x1C53BB6B
	ebmlTagChapters        = 0x1043A770
	ebmlTagTags            = 0x1254C367
	ebmlTagTag             = 0x7373
	ebmlTagTargets         = 0x63C0
	ebmlTagTargetType      = 0x63CA
	ebmlTagTagTrackUID     = 0x63C5
	ebmlTagSimpleTag       = 0x67C8
	ebmlTagTagName         = 0x45A3
	ebmlTagTagLanguage     = 0x447A
	ebmlTagTagDefault      = 0x4484
	ebmlTagTagString       = 0x4487
	ebmlTagTagBinary       = 0x4485
)

var ebmlIndeterminateCoding = [...]uint64{
	0, // these values in the "length" field all decode to `ebmlIndeterminate`.
	0xFF,
	0x7FFF,
	0x3FFFFF,
	0x1FFFFFFF,
	0x0FFFFFFFFF,
	0x07FFFFFFFFFF,
	0x03FFFFFFFFFFFF,
	0x01FFFFFFFFFFFFFF,
}

func fixedUint(data []byte) uint64 {
	var x uint64 = 0
	for _, b := range data {
		x = x<<8 | uint64(b)
	}
	return x
}

func ebmlTagID(data []byte) (uint64, int) {
	if len(data) != 0 && data[0] != 0 {
		// 1xxxxxxx
		// 01xxxxxx xxxxxxxx
		// 001xxxxx xxxxxxxx xxxxxxxx
		// ...
		// 00000001 xxxxxxxx xxxxxxxx xxxxxxxx xxxxxxxx xxxxxxxx xxxxxxxx xxxxxxxx
		//        ^---- this length marker is included in tag ids but not in other ints
		consumed := 9
		for b := data[0]; b != 0; b >>= 1 {
			consumed -= 1
		}
		if len(data) >= consumed {
			return fixedUint(data[:consumed]), consumed
		}
	}
	return 0, 0
}

func ebmlUint(data []byte) (uint64, int) {
	id, consumed := ebmlTagID(data)
	if ebmlIndeterminateCoding[consumed] == id {
		return ebmlIndeterminate, consumed
	}
	return id & ^(1 << uint(7*consumed)), consumed
}

type ebmlTag struct {
	Consumed int
	ID       uint
	Length   uint64
}

func ebmlParseTagIncomplete(data []byte) ebmlTag {
	if id, off := ebmlTagID(data); off != 0 {
		if length, off2 := ebmlUint(data[off:]); off2 != 0 {
			return ebmlTag{off + off2, uint(id), length}
		}
	}
	return ebmlTag{0, 0, 0}
}

func ebmlParseTag(data []byte) ebmlTag {
	if tag := ebmlParseTagIncomplete(data); tag.Length+uint64(tag.Consumed) <= uint64(len(data)) {
		return tag
	}
	return ebmlTag{0, 0, 0}
}

func (t ebmlTag) Contents(data []byte) []byte {
	return data[t.Consumed : uint64(t.Consumed)+t.Length]
}

func (t ebmlTag) Skip(data []byte) []byte {
	return data[uint64(t.Consumed)+t.Length:]
}

type Set struct {
	mutex   sync.Mutex // protects `streams`
	streams map[string]*Broadcast
	// How long to keep a stream alive after a call to `Close`.
	Timeout time.Duration
	// Called when the stream actually is actually closed (<=> timeout has elapsed.)
	OnStreamClose func(id string)
}

type Broadcast struct {
	Created  time.Time
	closing  time.Duration
	Closed   bool
	HasVideo bool
	HasAudio bool
	Width    uint // Dimensions of the video track that came last in the `Tracks` tag.
	Height   uint // Hopefully, there's only one video track in the file.

	vlock   sync.Mutex // protects `viewers`. not RWMutex because there's only one reader.
	viewers map[chan<- []byte]*viewer
	buffer  []byte
	header  []byte // The EBML (DocType) tag.
	tracks  []byte // The beginning of the Segment (Tracks + Info).

	time struct {
		last  uint64 // Last seen block timecode. The next timecode must be no less than that.
		recv  uint64 // Last received cluster timecode, shifted to ensure monotonicity.
		sent  uint64 // Last sent cluster timecode. (All viewers receive same clusters.)
		shift uint64 // By how much the cluster timecode has been shifted.
	}

	// These values are for the whole stream, so they include audio and muxing overhead.
	// The latter is negligible, however, and the former is normally about 64k,
	// so also negligible. Or at least predictable.
	rateUnit float64
	RateMean float64
	RateVar  float64
}

type viewer struct {
	// This function may return `false` to signal that it cannot write any more data.
	// The stream will resynchronize at next keyframe.
	write func(data []byte) bool
	// Viewers may hop between streams, but should only receive headers once.
	// This includes track info, as codecs must stay the same between segments.
	skipHeaders bool
	// We group blocks into indeterminate-length clusters. So long as
	// the cluster's timecode has not changed, there's no need to start a new one.
	skipCluster bool
	// To avoid decoding errors due to missing reference frames, the first
	// frame of each track received by a viewer must be a keyframe.
	// Each track for which a keyframe has been sent is marked by a bit here.
	seenKeyframes uint32
}

func (ctx *Set) Readable(id string) (*Broadcast, bool) {
	if ctx.streams == nil {
		return nil, false
	}
	ctx.mutex.Lock()
	cast, ok := ctx.streams[id]
	ctx.mutex.Unlock()
	return cast, ok
}

func (ctx *Set) Writable(id string) (*Broadcast, bool) {
	ctx.mutex.Lock()
	defer ctx.mutex.Unlock()
	if ctx.streams == nil {
		ctx.streams = make(map[string]*Broadcast)
	}
	if cast, ok := ctx.streams[id]; ok {
		if cast.closing == -1 {
			return nil, false
		}
		cast.closing = -1
		return cast, true
	}
	cast := NewBroadcast()
	ctx.streams[id] = &cast
	go func() {
		ticker := time.NewTicker(time.Second)
		for range ticker.C {
			if cast.closing >= 0 {
				if cast.closing += time.Second; cast.closing > ctx.Timeout {
					ctx.mutex.Lock()
					delete(ctx.streams, id)
					ctx.mutex.Unlock()
					ticker.Stop()

					cast.Closed = true
					cast.vlock.Lock()
					for _, cb := range cast.viewers {
						cb.write([]byte{})
					}
					cast.vlock.Unlock()
					if ctx.OnStreamClose != nil {
						ctx.OnStreamClose(id)
					}
				}
			}
			// exponentially weighted moving moments at a = 0.5
			//     avg[n] = a * x + (1 - a) * avg[n - 1]
			//     var[n] = a * (x - avg[n]) ** 2 / (1 - a) + (1 - a) * var[n - 1]
			cast.RateMean += cast.rateUnit / 2
			cast.RateVar += cast.rateUnit*cast.rateUnit - cast.RateVar/2
			cast.rateUnit = -cast.RateMean
		}
	}()
	return &cast, true
}

func NewBroadcast() Broadcast {
	return Broadcast{
		Created: time.Now().UTC(),
		closing: -1,
		viewers: make(map[chan<- []byte]*viewer),
	}
}

func (cast *Broadcast) Close() error {
	cast.closing = 0
	return nil
}

func (cast *Broadcast) Connect(ch chan<- []byte, skipHeaders bool) {
	write := func(data []byte) bool {
		// `Broadcast.Write` emits data in block-sized chunks.
		// Thus the buffer size is measured in frames, not bytes.
		if len(ch) == cap(ch) {
			return false
		}
		ch <- data
		return true
	}

	cast.vlock.Lock()
	cast.viewers[ch] = &viewer{write, skipHeaders, false, 0}
	cast.vlock.Unlock()
}

func (cast *Broadcast) Disconnect(ch chan<- []byte) {
	cast.vlock.Lock()
	delete(cast.viewers, ch)
	cast.vlock.Unlock()
}

func (cast *Broadcast) Reset() {
	cast.buffer = nil
}

func (cast *Broadcast) Write(data []byte) (int, error) {
	cast.rateUnit += float64(len(data))
	cast.buffer = append(cast.buffer, data...)

	for {
		buf := cast.buffer
		tag := ebmlParseTagIncomplete(buf)
		if tag.Consumed == 0 {
			return len(data), nil
		}

		if tag.ID == ebmlTagSegment || tag.ID == ebmlTagTracks || tag.ID == ebmlTagCluster {
			// Parse the contents of these tags in the same loop.
			buf = buf[:tag.Consumed]
			// Chrome crashes if an indeterminate length is not encoded as 0xFF.
			// If we want to recode it, we'll also need some space for a Void tag.
			if tag.Length == ebmlIndeterminate && tag.Consumed >= 7 {
				cast.buffer[4] = 0xFF
				cast.buffer[5] = ebmlTagVoid
				cast.buffer[6] = 0x80 | byte(tag.Consumed-7)
			}
		} else {
			total := tag.Length + uint64(tag.Consumed)
			if total > 1024*1024 {
				return 0, errors.New("data block too big")
			}

			if total > uint64(len(buf)) {
				return len(data), nil
			}

			buf = buf[:total]
		}

		switch tag.ID {
		case ebmlTagSeekHead:
			// Disallow seeking.
		case ebmlTagChapters:
			// Disallow seeking again.
		case ebmlTagCues:
			// Disallow even more seeking.
		case ebmlTagVoid:
			// Waste of space.
		case ebmlTagTags:
			// Maybe later.
		case ebmlTagCluster:
			// Ignore boundaries, we'll regroup the data anyway.
		case ebmlTagPrevSize:
			// Disallow backward seeking too.

		case ebmlTagEBML:
			// The header is the same in all WebM-s.
			if len(cast.header) == 0 {
				cast.header = append([]byte{}, buf...)
			}

		case ebmlTagSegment:
			cast.HasVideo = false
			cast.HasAudio = false
			cast.Width = 0
			cast.Height = 0
			cast.tracks = append([]byte{}, buf...)
			// Will recalculate this when the first block arrives.
			cast.time.shift = 0

		case ebmlTagInfo:
			// Default timecode resolution in Matroska is 1 ms. This value is required
			// in WebM; we'll check just in case. Obviously, our timecode rewriting
			// logic won't work with non-millisecond resolutions.
			var scale uint64 = 0

			for buf2 := tag.Contents(buf); len(buf2) != 0; {
				tag2 := ebmlParseTag(buf2)

				switch tag2.ID {
				case 0:
					return 0, errors.New("malformed EBML")

				case ebmlTagDuration:
					total := tag2.Length + uint64(tag2.Consumed) - 2
					if total > 0x7F {
						// I'd rather avoid shifting memory. What kind of integer
						// needs 128 bytes, anyway?
						return 0, errors.New("EBML Duration too large")
					}
					// Live streams must not have a duration.
					buf2[0] = ebmlTagVoid
					buf2[1] = 0x80 | byte(total)

				case ebmlTagTimecodeScale:
					scale = fixedUint(tag2.Contents(buf2))
				}

				buf2 = tag2.Skip(buf2)
			}

			if scale != 1000000 {
				return 0, errors.New("invalid timecode scale")
			}

			cast.tracks = append(cast.tracks, buf...)

		case ebmlTagTrackEntry:
			// Since `viewer.seenKeyframes` is a 32-bit vector,
			// we need to check that there are at most 32 tracks.
			for buf2 := tag.Contents(buf); len(buf2) != 0; {
				tag2 := ebmlParseTag(buf2)

				switch tag2.ID {
				case 0:
					return 0, errors.New("malformed EBML")

				case ebmlTagTrackNumber:
					// go needs sizeof.
					if t := fixedUint(tag2.Contents(buf2)); t >= 32 {
						return 0, errors.New("too many tracks?")
					}

				case ebmlTagAudio:
					cast.HasAudio = true

				case ebmlTagVideo:
					cast.HasVideo = true
					// While we're here, let's grab some metadata, too.
					for buf3 := tag2.Contents(buf2); len(buf3) != 0; {
						tag3 := ebmlParseTag(buf3)

						switch tag3.ID {
						case 0:
							return 0, errors.New("malformed EBML")

						case ebmlTagPixelWidth:
							cast.Width = uint(fixedUint(tag3.Contents(buf3)))

						case ebmlTagPixelHeight:
							cast.Height = uint(fixedUint(tag3.Contents(buf3)))
						}

						buf3 = tag3.Skip(buf3)
					}
				}

				buf2 = tag2.Skip(buf2)
			}

			cast.tracks = append(cast.tracks, buf...)

		case ebmlTagTracks:
			cast.tracks = append(cast.tracks, buf...)

		case ebmlTagTimecode:
			// Will reencode it when sending a Cluster.
			cast.time.recv = fixedUint(tag.Contents(buf)) + cast.time.shift

		case ebmlTagBlockGroup, ebmlTagSimpleBlock:
			key := false
			block := tag.Contents(buf)

			if tag.ID == ebmlTagBlockGroup {
				key, block = true, nil

				for buf2 := tag.Contents(buf); len(buf2) != 0; {
					tag2 := ebmlParseTag(buf2)

					switch tag2.ID {
					case 0:
						return 0, errors.New("malformed EBML")

					case ebmlTagBlock:
						block = tag2.Contents(buf2)

					case ebmlTagReferenceBlock:
						// Keyframes, by definition, have no reference frame.
						key = fixedUint(tag2.Contents(buf2)) == 0
					}

					buf2 = tag2.Skip(buf2)
				}

				if block == nil {
					return 0, errors.New("a BlockGroup contains no Blocks")
				}
			}

			track, consumed := ebmlUint(block)
			if consumed == 0 || track >= 32 || len(block) < consumed+3 {
				return 0, errors.New("invalid track")
			}
			// This bit is always 0 in a Block, but 1 in a keyframe SimpleBlock.
			key = key || block[consumed+2]&0x80 != 0
			// Block timecodes are relative to cluster ones.
			timecode := uint64(block[consumed+0])<<8 | uint64(block[consumed+1])
			if cast.time.recv+timecode < cast.time.last {
				cast.time.shift += cast.time.last - (cast.time.recv + timecode)
				cast.time.recv = cast.time.last - timecode
			}
			cast.time.last = cast.time.recv + timecode

			ctc := cast.time.recv
			cluster := []byte{
				ebmlTagCluster >> 24 & 0xFF,
				ebmlTagCluster >> 16 & 0xFF,
				ebmlTagCluster >> 8 & 0xFF,
				ebmlTagCluster & 0xFF, 0xFF,
				ebmlTagTimecode, 0x88,
				byte(ctc >> 56), byte(ctc >> 48), byte(ctc >> 40), byte(ctc >> 32),
				byte(ctc >> 24), byte(ctc >> 16), byte(ctc >> 8), byte(ctc),
			}

			trackMask := uint32(1) << track
			cast.vlock.Lock()
			for _, cb := range cast.viewers {
				if !cb.skipHeaders {
					if !cb.write(cast.header) || !cb.write(cast.tracks) {
						continue
					}

					cb.skipHeaders = true
					cb.skipCluster = false
				}

				if key {
					cb.seenKeyframes |= trackMask
				}

				if cb.seenKeyframes&trackMask != 0 {
					if !cb.skipCluster || timecode != cast.time.sent {
						cb.skipCluster = cb.write(cluster)
					}
					if !cb.skipCluster || !cb.write(buf) {
						cb.seenKeyframes &= ^trackMask
					}
				}
			}

			cast.vlock.Unlock()
			cast.time.sent = timecode

		default:
			return 0, errors.New("unknown EBML tag")
		}

		cast.buffer = cast.buffer[len(buf):]
	}
}
