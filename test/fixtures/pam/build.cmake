# Test-only target injected by the CI build through CMAKE_PROJECT_tabby_freerdp_INCLUDE.
# Keeps the production helper's CMake source and build inventory independent of test fixtures.
add_executable(tabby-pam-test-server "${CMAKE_CURRENT_LIST_DIR}/../../../native/pam-test-server.c")
target_include_directories(tabby-pam-test-server PRIVATE "${FREERDP_SOURCE_DIR}/include"
    "${CMAKE_CURRENT_BINARY_DIR}/freerdp/include" "${FREERDP_SOURCE_DIR}/winpr/include"
    "${CMAKE_CURRENT_BINARY_DIR}/freerdp/winpr/include")
target_compile_features(tabby-pam-test-server PRIVATE c_std_11)
target_link_libraries(tabby-pam-test-server PRIVATE freerdp-client freerdp winpr OpenSSL::SSL OpenSSL::Crypto)
if(WIN32)
    target_link_libraries(tabby-pam-test-server PRIVATE ws2_32)
endif()
