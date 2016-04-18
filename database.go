package main

import (
	"crypto/md5"
	"encoding/hex"
	"errors"
	"fmt"
	"math/rand"
	"strings"
)

var (
	ErrNotSupported   = errors.New("Unsupported operation.")
	ErrInvalidToken   = errors.New("Invalid token.")
	ErrUserNotExist   = errors.New("Invalid username/password.")
	ErrUserNotUnique  = errors.New("This name/email is already taken.")
	ErrStreamActive   = errors.New("Can't do that while a stream is active.")
	ErrStreamNotExist = errors.New("Unknown stream.")
	ErrStreamNotHere  = errors.New("Stream is online on another server.")
	ErrStreamOffline  = errors.New("Stream is offline.")
)

var randomTokenAlphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"

func makeToken(length int) string {
	xs := make([]byte, length)
	for i := 0; i < length; i++ {
		xs[i] = randomTokenAlphabet[rand.Intn(len(randomTokenAlphabet))]
	}
	return string(xs)
}

func gravatarURL(email string, size int) string {
	hash := md5.Sum([]byte(strings.ToLower(email)))
	hexhash := hex.EncodeToString(hash[:])
	return fmt.Sprintf("//www.gravatar.com/avatar/%s?s=%d", hexhash, size)
}

type UserMetadata struct {
	ID              int64
	Login           string
	Email           string
	Name            string
	About           string
	Activated       bool
	ActivationToken string
	StreamToken     string
}

type StreamMetadata struct {
	UserName  string
	UserAbout string
	Name      string
	Email     string
	About     string
	Server    string
}

func (u *UserMetadata) GravatarURL(size int) string {
	return gravatarURL(u.Email, size)
}

func (s *StreamMetadata) GravatarURL(size int) string {
	return gravatarURL(s.Email, size)
}

type Database interface {
	// Create a new user entry. Display name = name, activation token is generated randomly.
	NewUser(name string, email string, password []byte) (*UserMetadata, error)
	// Authenticate a user. (The only way to retrieve a user ID, by design.)
	GetUserID(email string, password []byte) (int64, error)
	// A version of the above function that returns the rest of the data too.
	GetUserFull(email string, password []byte) (*UserMetadata, error)
	// Allow a user to create streams.
	ActivateUser(id int64, token string) error
	// Various setters. They're separate for efficiency; requests to modify
	// different fields are expected to be made via XHR separate from each other.
	SetUserName(id int64, name string, displayName string) error
	SetUserEmail(id int64, email string) (string, error) // returns new activation token
	SetUserAbout(id int64, about string) error
	SetUserPassword(id int64, password []byte) error
	// stream id = user id
	SetStreamName(id int64, name string) error
	SetStreamAbout(id int64, about string) error
	// Mark a stream as active on the current server.
	StartStream(user string, token string) error
	// Mark a stream as offline.
	StopStream(user string) error
	// Retrieve the string identifying the owner of the stream.
	// Clients talking to the wrong server may be redirected there, for example.
	// Unless the result is the current server, an ErrStreamNotHere is also returned.
	GetStreamServer(user string) (string, error)
	GetStreamMetadata(user string) (*StreamMetadata, error)
}
