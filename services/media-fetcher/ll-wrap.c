/* Landlock CONNECT-only wrapper. UAPI inlined — bookworm headers lack net fields.
 * Requires Landlock ABI >= 4 (TCP bind/connect, Linux 6.7+). Fail closed otherwise. */
#define _GNU_SOURCE
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#define __NR_landlock_add_rule 445
#define __NR_landlock_restrict_self 446
#endif
#ifndef PR_SET_NO_NEW_PRIVS
#define PR_SET_NO_NEW_PRIVS 38
#endif

#define LANDLOCK_CREATE_RULESET_VERSION (1U << 0)
#define LANDLOCK_ACCESS_NET_CONNECT_TCP (1ULL << 1)
#define LANDLOCK_RULE_NET_PORT 2
#define LANDLOCK_MIN_ABI 4

struct landlock_ruleset_attr {
  uint64_t handled_access_fs;
  uint64_t handled_access_net;
};
struct landlock_net_port_attr {
  uint64_t allowed_access;
  uint64_t port;
};

static int landlock_abi(void) {
  long abi = syscall(__NR_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 0) return -errno;
  return (int)abi;
}

static int enforce(unsigned long port) {
  int abi = landlock_abi();
  if (abi < LANDLOCK_MIN_ABI) {
    fprintf(stderr, "ll-wrap: landlock ABI %d < 4\n", abi);
    return 1;
  }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    fprintf(stderr, "ll-wrap: no_new_privs: %s\n", strerror(errno));
    return 1;
  }
  struct landlock_ruleset_attr rs = { .handled_access_net = LANDLOCK_ACCESS_NET_CONNECT_TCP };
  int fd = (int)syscall(__NR_landlock_create_ruleset, &rs, sizeof(rs), 0);
  if (fd < 0) {
    fprintf(stderr, "ll-wrap: landlock unavailable (%s)\n", strerror(errno));
    return 1;
  }
  struct landlock_net_port_attr net = {
    .allowed_access = LANDLOCK_ACCESS_NET_CONNECT_TCP,
    .port = port,
  };
  if (syscall(__NR_landlock_add_rule, fd, LANDLOCK_RULE_NET_PORT, &net, 0) != 0) {
    fprintf(stderr, "ll-wrap: add port: %s\n", strerror(errno));
    close(fd);
    return 1;
  }
  if (syscall(__NR_landlock_restrict_self, fd, 0) != 0) {
    fprintf(stderr, "ll-wrap: restrict: %s\n", strerror(errno));
    close(fd);
    return 1;
  }
  close(fd);
  return 0;
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "--check") == 0) {
    int abi = landlock_abi();
    if (abi < LANDLOCK_MIN_ABI) {
      fprintf(stderr, "ll-wrap: landlock ABI %d < 4\n", abi);
      return 1;
    }
    if (enforce(1) != 0) return 1;
    printf("landlock_abi=%d\n", abi);
    return 0;
  }
  if (argc < 3) return 2;
  unsigned long port = strtoul(argv[1], NULL, 10);
  if (port < 1 || port > 65535) return 2;
  if (enforce(port) != 0) return 1;
  execvp(argv[2], argv + 2);
  fprintf(stderr, "ll-wrap: exec: %s\n", strerror(errno));
  return 127;
}
