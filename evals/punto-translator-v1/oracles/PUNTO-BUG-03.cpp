#include "punto/ipc_server.hpp"

#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <atomic>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <string>
#include <string_view>

namespace {

std::string send_command(const std::string &socket_path, std::string_view command) {
  const int fd = ::socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) throw std::runtime_error("socket");
  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  std::strncpy(address.sun_path, socket_path.c_str(), sizeof(address.sun_path) - 1);
  if (::connect(fd, reinterpret_cast<sockaddr *>(&address), sizeof(address)) != 0) {
    ::close(fd);
    throw std::runtime_error("connect");
  }
  const char *cursor = command.data();
  std::size_t remaining = command.size();
  while (remaining > 0) {
    const ssize_t count = ::write(fd, cursor, remaining);
    if (count <= 0) throw std::runtime_error("write");
    cursor += count;
    remaining -= static_cast<std::size_t>(count);
  }
  ::shutdown(fd, SHUT_WR);
  std::string response;
  char buffer[256];
  while (const ssize_t count = ::read(fd, buffer, sizeof(buffer))) {
    if (count < 0) throw std::runtime_error("read");
    response.append(buffer, static_cast<std::size_t>(count));
  }
  ::close(fd);
  return response;
}

bool require_equal(std::string_view actual, std::string_view expected, std::string_view label) {
  if (actual == expected) return true;
  std::cerr << label << ": expected [" << expected << "] got [" << actual << "]\n";
  return false;
}

}  // namespace

int main() {
  char directory_template[] = "/tmp/punto-hidden-oracle-XXXXXX";
  char *directory = ::mkdtemp(directory_template);
  if (directory == nullptr) return 2;
  const std::string socket_path =
      (std::filesystem::path(directory) / "oracle.sock").string();
  std::atomic<bool> enabled{true};
  punto::IpcServer server(
      enabled,
      [](const std::string &) { return punto::IpcResult{true, "reloaded"}; },
      []() { return punto::IpcResult{true, "stats"}; },
      socket_path,
      {},
      false);
  if (!server.start()) return 2;

  bool passed = true;
  passed &= require_equal(send_command(socket_path, "GET_STATUS\n"), "OK ENABLED\n", "valid status");
  passed &= require_equal(send_command(socket_path, "SET_STATUS 0\n"), "OK DISABLED\n", "valid set");
  passed &= require_equal(send_command(socket_path, "STATS\n"), "OK stats\n", "valid stats");
  for (const std::string_view invalid : {
           "GET_STATUS_EXTRA\n",
           "GET_STATUS now\n",
           "STATSx\n",
           "STATS extra\n",
           "SHUTDOWN_LATER\n",
           "SET_STATUSX 0\n",
       }) {
    passed &= require_equal(send_command(socket_path, invalid), "ERROR Unknown command\n", invalid);
  }
  passed &= require_equal(
      send_command(socket_path, "SET_STATUS 0 extra\n"),
      "ERROR Invalid argument\n",
      "set extra token");

  server.stop();
  std::filesystem::remove_all(directory);
  return passed ? 0 : 1;
}
